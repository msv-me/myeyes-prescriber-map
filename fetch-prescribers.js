#!/usr/bin/env node
/**
 * Fetch prescriber contacts from ActiveCampaign, geocode addresses,
 * optionally enrich with Google Places, and output prescribers.json.
 *
 * Usage:
 *   node fetch-prescribers.js              # Full fetch + geocode
 *   node fetch-prescribers.js --enrich     # Also enrich via Google Places
 *   node fetch-prescribers.js --dry-run    # Preview without writing file
 */

import "dotenv/config";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "data", "prescribers.json");
const PUBLIC_OUTPUT = join(__dirname, "public", "prescribers.json");

const AC_BASE_URL = process.env.ACTIVECAMPAIGN_URL;
const AC_API_KEY = process.env.ACTIVECAMPAIGN_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GEOCODER = process.env.GEOCODER || "nominatim";

const PRESCRIBER_TAG_ID = "45"; // "Doctor - Referring Doctor"
const BATCH_SIZE = 100;

// Field IDs from ActiveCampaign
const FIELD_MAP = {
  4: "address1",
  5: "address2",
  6: "city",
  7: "state",
  8: "zip",
  9: "specialty",
  23: "doctorFirstName",
  24: "doctorLastName",
  25: "practiceName",
  26: "doctorEmail",
  32: "npi",
  61: "practiceType",
  111: "prescriberType",
};

const flags = new Set(process.argv.slice(2));
const ENRICH = flags.has("--enrich");
const DRY_RUN = flags.has("--dry-run");

// ---------------------------------------------------------------------------
// ActiveCampaign API
// ---------------------------------------------------------------------------

async function acFetch(path, params = {}) {
  const url = new URL(`/api/3/${path}`, `https://${AC_BASE_URL}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { "Api-Token": AC_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AC API ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchAllPrescribers() {
  let offset = 0;
  const all = [];
  console.log("Fetching prescribers from ActiveCampaign (tag 45)...");

  while (true) {
    const data = await acFetch("contacts", {
      tagid: PRESCRIBER_TAG_ID,
      limit: BATCH_SIZE,
      offset,
    });
    const contacts = data.contacts || [];
    all.push(...contacts);
    const total = parseInt(data.meta?.total || "0", 10);
    console.log(`  Fetched ${all.length} / ${total}`);
    if (all.length >= total || contacts.length === 0) break;
    offset += BATCH_SIZE;
  }

  return all;
}

async function fetchFieldValues(contactId) {
  const data = await acFetch(`contacts/${contactId}/fieldValues`);
  const fields = {};
  for (const fv of data.fieldValues || []) {
    const name = FIELD_MAP[fv.field];
    if (name && fv.value) {
      fields[name] = fv.value;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

let geocodeCount = 0;

async function geocodeNominatim(address) {
  // Respect Nominatim rate limit (1 req/sec)
  if (geocodeCount > 0) await sleep(1100);
  geocodeCount++;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "MyEyes-PrescriberMap/1.0" },
  });
  if (!res.ok) return null;
  const results = await res.json();
  if (results.length === 0) return null;
  return {
    lat: parseFloat(results[0].lat),
    lng: parseFloat(results[0].lon),
    source: "nominatim",
  };
}

async function geocodeGoogle(address) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", GOOGLE_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, source: "google" };
}

async function geocode(address) {
  if (GEOCODER === "google" && GOOGLE_KEY) {
    return geocodeGoogle(address);
  }
  return geocodeNominatim(address);
}

// ---------------------------------------------------------------------------
// Google Places enrichment (optional)
// ---------------------------------------------------------------------------

async function enrichWithGoogle(prescriber) {
  if (!GOOGLE_KEY) return { healthSystem: null, verified: false };

  const query = `${prescriber.name} ophthalmologist ${prescriber.city || ""} ${prescriber.state || ""}`.trim();
  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/textsearch/json"
  );
  url.searchParams.set("query", query);
  url.searchParams.set("key", GOOGLE_KEY);
  url.searchParams.set("type", "doctor");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return { healthSystem: null, verified: false };
    const data = await res.json();

    if (data.results?.length > 0) {
      const place = data.results[0];
      return {
        healthSystem: place.name || null,
        googleAddress: place.formatted_address || null,
        verified: true,
        placeRating: place.rating || null,
      };
    }
  } catch (e) {
    console.warn(`  Google Places error for ${prescriber.name}: ${e.message}`);
  }
  return { healthSystem: null, verified: false };
}

// ---------------------------------------------------------------------------
// Build prescriber record
// ---------------------------------------------------------------------------

function buildAddress(fields) {
  const parts = [
    fields.address1,
    fields.address2,
    fields.city,
    fields.state,
    fields.zip,
  ].filter(Boolean);
  return parts.join(", ");
}

async function buildPrescriber(contact, fields) {
  const name =
    [
      fields.doctorFirstName || contact.firstName,
      fields.doctorLastName || contact.lastName,
    ]
      .filter(Boolean)
      .join(" ") || "(unknown)";

  const fullAddress = buildAddress(fields);
  let geo = null;
  if (fullAddress) {
    geo = await geocode(fullAddress);
    if (!geo && fields.zip) {
      // Fallback: geocode just the zip
      geo = await geocode(`${fields.zip}, USA`);
    }
  }

  const prescriber = {
    id: contact.id,
    name,
    email: fields.doctorEmail || contact.email || null,
    phone: contact.phone || null,
    organization: contact.orgname || fields.practiceName || null,
    specialty: fields.specialty || fields.prescriberType || null,
    practiceType: fields.practiceType || null,
    npi: fields.npi || null,
    address: {
      street: [fields.address1, fields.address2].filter(Boolean).join(", "),
      city: fields.city || null,
      state: fields.state || null,
      zip: fields.zip || null,
      full: fullAddress || null,
    },
    lat: geo?.lat || null,
    lng: geo?.lng || null,
    geoSource: geo?.source || null,
    healthSystem: null,
    verified: false,
  };

  // Optional Google Places enrichment
  if (ENRICH) {
    const enrichment = await enrichWithGoogle(prescriber);
    prescriber.healthSystem = enrichment.healthSystem;
    prescriber.verified = enrichment.verified;
    if (enrichment.googleAddress) {
      prescriber.googleAddress = enrichment.googleAddress;
    }
  }

  return prescriber;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!AC_BASE_URL || !AC_API_KEY) {
    console.error(
      "Missing ACTIVECAMPAIGN_URL or ACTIVECAMPAIGN_API_KEY in .env"
    );
    process.exit(1);
  }

  console.log(`Geocoder: ${GEOCODER}`);
  console.log(`Enrich via Google Places: ${ENRICH}`);
  console.log("");

  const contacts = await fetchAllPrescribers();
  console.log(`\nFetching field values for ${contacts.length} contacts...`);

  const prescribers = [];
  let geocoded = 0;
  let skipped = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const fields = await fetchFieldValues(contact.id);
    const p = await buildPrescriber(contact, fields);

    if (p.lat && p.lng) {
      geocoded++;
    } else if (!p.address.full) {
      skipped++;
    }

    prescribers.push(p);

    if ((i + 1) % 25 === 0 || i === contacts.length - 1) {
      console.log(
        `  Processed ${i + 1}/${contacts.length} (geocoded: ${geocoded}, no address: ${skipped})`
      );
    }
  }

  const output = {
    generated: new Date().toISOString(),
    total: prescribers.length,
    geocoded,
    noAddress: skipped,
    prescribers: prescribers.sort((a, b) => a.name.localeCompare(b.name)),
  };

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Would write to:", OUTPUT_PATH);
    console.log(`Total: ${output.total}, Geocoded: ${geocoded}, No address: ${skipped}`);
    console.log("Sample:", JSON.stringify(prescribers[0], null, 2));
  } else {
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    // Also copy to public/ so the frontend can serve it
    writeFileSync(PUBLIC_OUTPUT, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${prescribers.length} prescribers to:`);
    console.log(`  ${OUTPUT_PATH}`);
    console.log(`  ${PUBLIC_OUTPUT}`);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
