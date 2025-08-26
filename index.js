require('dotenv').config();
const express = require('express');
const app = express();
const cors = require("cors")
const PORT = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const eventsCollection = client.db("WormysCantina").collection("events");
    const rsvpsCollection = client.db("WormysCantina").collection("rsvps");

    // POST route to add event
    app.post("/events", async (req, res) => {
      try {
        const eventData = req.body;

        const result = await eventsCollection.insertOne(eventData);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get all events
    app.get("/get-events", async (req, res) => {
      try {
        const events = await eventsCollection.find().toArray();
        res.json(events);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Get single event by ID
    app.get("/single-event/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
        res.json(event);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // RSPV 
    app.post("/rsvps", async (req, res) => {
      try {
        const { eventId, firstName, lastName, phone, email, guests } = req.body;

        const rsvpData = {
          eventId,
          firstName,
          lastName,
          phone,
          email,
          guests,
          createdAt: new Date(),
        };

        const result = await rsvpsCollection.insertOne(rsvpData);
        res.status(201).json(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to submit RSVP" });
      }
    });

    // Get all RSVPs for a specific event
    app.get("/rsvps/:eventId", async (req, res) => {
      try {
        const { eventId } = req.params;
        const rsvps = await rsvpsCollection.find({ eventId }).toArray();
        res.json(rsvps);
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch RSVPs" });
      }
    });

    // Update event
    app.put("/update-event/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const updatedEvent = req.body;

        const result = await eventsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedEvent }
        );

        res.json(result);
      } catch (error) {
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  }
  finally { }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});



