require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

/**
 * Supabase seed for Wormy's Cantina — starter data for a FRESH/EMPTY database.
 *
 * SAFETY: this only inserts into tables that are EMPTY. If a table already has
 * rows (i.e. you have real data), that table is left completely untouched — it
 * will never overwrite or delete your events/musicians. So it is safe to run by
 * accident, but it is essentially a no-op once your DB is populated.
 *
 * The past events below are EXAMPLES (real photos, placeholder titles/dates) and
 * are only used when the events table starts empty.
 */

const events = [
  // Upcoming
  {
    title: "The Cartwrights - Musicians",
    slug: "the-cartwrights-oct-17-2026",
    description: "Live performance featuring Chuck Hall and Sean Markey.",
    date: "2026-10-17",
    time: "2:00 PM",
    venue: "Wormy's Cantina",
    address: "6001 E Surrey Drive, Cave Creek, AZ 85331",
    hero_image: "/assets/events/cartwrights.png",
    gallery: [],
    status: "upcoming",
    notes: "",
    reminder_days_before: 2,
    external_link: "https://www.facebook.com/people/The-Cartwrights/61571703237502/",
  },
  // Past (example archive)
  {
    title: "Spring Crawfish Boil",
    slug: "spring-crawfish-boil-2025",
    description: "A sold-out afternoon of spicy crawfish, cold drinks, and live music under the Cave Creek sky.",
    date: "2025-04-12",
    time: "2:00 PM",
    venue: "Wormy's Cantina",
    address: "6001 E Surrey Drive, Cave Creek, AZ 85331",
    hero_image: "/assets/img/Singers.jpg",
    gallery: ["/assets/gallery/g-1.jpeg", "/assets/gallery/g-2.jpeg", "/assets/gallery/g-3.jpeg", "/assets/gallery/g-4.jpeg"],
    status: "past",
    notes: "",
    reminder_days_before: 2,
    external_link: "",
  },
  {
    title: "Backyard Acoustic Night",
    slug: "backyard-acoustic-night-2025",
    description: "An intimate evening of acoustic sets from local favorites on the back porch stage.",
    date: "2025-03-30",
    time: "6:00 PM",
    venue: "Wormy's Cantina",
    address: "6001 E Surrey Drive, Cave Creek, AZ 85331",
    hero_image: "/assets/img/March-30.jpg",
    gallery: ["/assets/gallery/g-5.jpeg", "/assets/gallery/g-6.jpeg", "/assets/gallery/g-7.jpeg"],
    status: "past",
    notes: "",
    reminder_days_before: 2,
    external_link: "",
  },
  {
    title: "Singer-Songwriter Showcase",
    slug: "singer-songwriter-showcase-2025",
    description: "Original songs and stories from the songwriters who make the Cantina sing.",
    date: "2025-02-15",
    time: "5:30 PM",
    venue: "Wormy's Cantina",
    address: "6001 E Surrey Drive, Cave Creek, AZ 85331",
    hero_image: "/assets/img/Singer-Songwriter.jpg",
    gallery: ["/assets/gallery/g-8.jpeg", "/assets/gallery/g-9.jpeg", "/assets/gallery/g-10.jpeg"],
    status: "past",
    notes: "",
    reminder_days_before: 2,
    external_link: "",
  },
];

const musicians = [
  {
    name: "Christopher Robin",
    instrument: "Solo Acoustic",
    image_url: "/assets/musicians/m-1.png",
    order: 0,
    description:
      "Christopher Robin is known for solo acoustic performances around Cave Creek, creating an intimate atmosphere that connects strongly with audiences.",
  },
  {
    name: "Pandy Raye",
    instrument: "Vocals and Mentoring",
    image_url: "/assets/musicians/m-2.png",
    order: 1,
    description:
      "Pandy Raye has been part of the Cave Creek music scene for over 20 years and has mentored many successful performers.",
  },
  {
    name: "Tim Brady",
    instrument: "Classic Rock and Americana",
    image_url: "/assets/musicians/m-3.png",
    order: 2,
    description:
      "Tim Brady performs with local groups in Cave Creek and is known for a broad live repertoire and community music presence.",
  },
  {
    name: "David Sheehy",
    instrument: "Singer-Songwriter",
    image_url: "/assets/musicians/m-4.png",
    order: 3,
    description:
      "David Sheehy has decades of experience, with original songs and covers spanning multiple generations of live music.",
  },
];

async function seed() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env");

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const countOf = async (table) => {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return count || 0;
  };

  console.log("Seed (only fills EMPTY tables — existing data is never touched):");

  // Events — insert only if the table is empty.
  const eventCount = await countOf("events");
  if (eventCount === 0) {
    const { error } = await supabase
      .from("events")
      .insert(events.map((e) => ({ ...e, updated_at: new Date().toISOString() })));
    if (error) throw new Error(`events insert failed: ${error.message}`);
    console.log(`  • seeded ${events.length} event(s) (1 upcoming + 3 example past)`);
  } else {
    console.log(`  • events: ${eventCount} existing row(s) — left untouched`);
  }

  // Musicians — insert only if the table is empty.
  const musicianCount = await countOf("musicians");
  if (musicianCount === 0) {
    const { error } = await supabase.from("musicians").insert(musicians);
    if (error) throw new Error(`musicians insert failed: ${error.message}`);
    console.log(`  • seeded ${musicians.length} musician(s)`);
  } else {
    console.log(`  • musicians: ${musicianCount} existing row(s) — left untouched`);
  }
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
