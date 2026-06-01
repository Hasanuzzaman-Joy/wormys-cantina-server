-- Wormy's Cantina — Supabase schema
-- Run this entire file in Supabase → SQL Editor → New Query

CREATE TABLE IF NOT EXISTS events (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title                TEXT        NOT NULL,
  slug                 TEXT        UNIQUE NOT NULL,
  description          TEXT        DEFAULT '',
  date                 TEXT        DEFAULT '',
  time                 TEXT        DEFAULT '',
  venue                TEXT        DEFAULT '',
  address              TEXT        DEFAULT '',
  hero_image           TEXT,
  gallery              JSONB       DEFAULT '[]',
  status               TEXT        DEFAULT 'upcoming',
  notes                TEXT        DEFAULT '',
  reminder_days_before INTEGER     DEFAULT 2,
  external_link        TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rsvps (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id    UUID        REFERENCES events(id) ON DELETE CASCADE,
  event_name  TEXT        DEFAULT '',
  first_name  TEXT        DEFAULT '',
  last_name   TEXT        DEFAULT '',
  email       TEXT        DEFAULT '',
  phone       TEXT        DEFAULT '',
  guests      INTEGER     DEFAULT 1,
  message     TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id             UUID,
  rsvp_id              UUID,
  email                TEXT,
  name                 TEXT,
  event_name           TEXT,
  event_date           TEXT,
  event_time           TEXT,
  event_address        TEXT,
  reminder_days_before INTEGER     DEFAULT 2,
  sent                 BOOLEAN     DEFAULT false,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS musicians (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT        NOT NULL,
  instrument  TEXT        DEFAULT '',
  image_url   TEXT        DEFAULT '',
  "order"     INTEGER     DEFAULT 0,
  description TEXT        DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT  PRIMARY KEY,
  value JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS users (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT        DEFAULT '',
  email      TEXT        UNIQUE,
  photo      TEXT        DEFAULT '',
  role       TEXT        DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Storage bucket for uploaded event/musician images (public read).
-- The server also creates this automatically on first upload if missing.
INSERT INTO storage.buckets (id, name, public)
VALUES ('uploads', 'uploads', true)
ON CONFLICT (id) DO NOTHING;
