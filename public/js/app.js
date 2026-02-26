/**
 * MyEyes Prescriber Map — Frontend
 * Reads prescribers.json, renders on Leaflet map, supports zip code search.
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let allPrescribers = [];
  let map, markerCluster, searchCircle;
  let searchLat = null,
    searchLng = null;

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    initMap();
    await loadData();
    bindEvents();
  }

  function initMap() {
    map = L.map("map").setView([39.8, -98.5], 4); // Center of US
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18,
    }).addTo(map);

    markerCluster = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
    });
    map.addLayer(markerCluster);
  }

  async function loadData() {
    document.getElementById("loading").classList.remove("hidden");
    try {
      const res = await fetch("prescribers.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allPrescribers = data.prescribers || [];

      const info = document.getElementById("data-info");
      info.textContent = `Data generated: ${new Date(data.generated).toLocaleString()} | ${data.total} prescribers (${data.geocoded} mapped)`;

      showPrescribers(allPrescribers);
    } catch (e) {
      console.error("Failed to load prescribers.json:", e);
      document.getElementById("data-info").textContent =
        "Error loading data. Run `npm run fetch` to generate prescribers.json.";
    } finally {
      document.getElementById("loading").classList.add("hidden");
    }
  }

  function bindEvents() {
    document.getElementById("search-btn").addEventListener("click", doSearch);
    document.getElementById("clear-btn").addEventListener("click", clearSearch);
    document.getElementById("zip-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------
  async function doSearch() {
    const zip = document.getElementById("zip-input").value.trim();
    if (!/^\d{5}$/.test(zip)) {
      alert("Please enter a valid 5-digit zip code.");
      return;
    }

    const radiusMiles = parseInt(
      document.getElementById("radius-select").value,
      10
    );

    // Geocode the zip code using Nominatim
    const geo = await geocodeZip(zip);
    if (!geo) {
      alert("Could not find location for zip code: " + zip);
      return;
    }

    searchLat = geo.lat;
    searchLng = geo.lng;

    // Filter prescribers within radius
    const nearby = allPrescribers
      .filter((p) => p.lat && p.lng)
      .map((p) => ({
        ...p,
        distance: haversine(searchLat, searchLng, p.lat, p.lng),
      }))
      .filter((p) => p.distance <= radiusMiles)
      .sort((a, b) => a.distance - b.distance);

    showPrescribers(nearby, true);

    // Draw search radius circle
    if (searchCircle) map.removeLayer(searchCircle);
    searchCircle = L.circle([searchLat, searchLng], {
      radius: radiusMiles * 1609.34, // miles to meters
      color: "#2980b9",
      fillColor: "#2980b9",
      fillOpacity: 0.06,
      weight: 2,
    }).addTo(map);

    // Add a marker for the searched zip
    L.marker([searchLat, searchLng], {
      icon: L.divIcon({
        className: "zip-marker",
        html: '<div style="background:#e74c3c;color:white;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;white-space:nowrap;">Patient: ' + zip + "</div>",
        iconSize: [80, 24],
        iconAnchor: [40, 12],
      }),
    })
      .addTo(map)
      .bindPopup(`<b>Patient Location</b><br>Zip: ${zip}`);

    // Fit map to circle bounds
    map.fitBounds(searchCircle.getBounds(), { padding: [20, 20] });

    document.getElementById("result-count").textContent =
      `${nearby.length} prescriber${nearby.length !== 1 ? "s" : ""} within ${radiusMiles} mi of ${zip}`;
  }

  function clearSearch() {
    searchLat = null;
    searchLng = null;
    if (searchCircle) {
      map.removeLayer(searchCircle);
      searchCircle = null;
    }
    document.getElementById("zip-input").value = "";
    document.getElementById("result-count").textContent = "";
    showPrescribers(allPrescribers);
    map.setView([39.8, -98.5], 4);
  }

  // -----------------------------------------------------------------------
  // Display
  // -----------------------------------------------------------------------
  function showPrescribers(prescribers, isFiltered = false) {
    markerCluster.clearLayers();

    // Remove previous zip markers
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker && !(layer instanceof L.MarkerClusterGroup)) {
        if (layer.options.icon?.options?.className === "zip-marker") return;
        // Keep cluster markers
      }
    });

    const withCoords = prescribers.filter((p) => p.lat && p.lng);

    withCoords.forEach((p) => {
      const marker = L.marker([p.lat, p.lng]);
      marker.bindPopup(buildPopup(p));
      markerCluster.addLayer(marker);
    });

    // Update list
    const listEl = document.getElementById("prescriber-list");
    const countEl = document.getElementById("list-count");
    countEl.textContent = `(${prescribers.length} total, ${withCoords.length} mapped)`;

    const displayList = isFiltered ? prescribers : prescribers.slice(0, 100);
    listEl.innerHTML = displayList
      .map(
        (p) => `
      <div class="prescriber-card" data-lat="${p.lat}" data-lng="${p.lng}">
        <div class="card-info">
          <h4>${esc(p.name)}${p.specialty ? " <span class='badge badge-specialty'>" + esc(p.specialty) + "</span>" : ""}</h4>
          <p>${esc(p.organization || "")}${p.address?.city ? " — " + esc(p.address.city) + ", " + esc(p.address.state || "") : ""}</p>
        </div>
        ${p.distance != null ? '<div class="card-distance">' + p.distance.toFixed(1) + " mi</div>" : ""}
      </div>`
      )
      .join("");

    if (!isFiltered && prescribers.length > 100) {
      listEl.innerHTML +=
        '<p style="text-align:center;color:#888;font-size:12px;padding:8px;">Showing first 100. Search by zip to see all nearby.</p>';
    }

    // Click card to fly to marker
    listEl.querySelectorAll(".prescriber-card").forEach((card) => {
      card.addEventListener("click", () => {
        const lat = parseFloat(card.dataset.lat);
        const lng = parseFloat(card.dataset.lng);
        if (lat && lng) {
          map.setView([lat, lng], 14);
          // Open popup for the closest marker
          markerCluster.eachLayer((layer) => {
            const ll = layer.getLatLng();
            if (
              Math.abs(ll.lat - lat) < 0.0001 &&
              Math.abs(ll.lng - lng) < 0.0001
            ) {
              layer.openPopup();
            }
          });
        }
      });
    });
  }

  function buildPopup(p) {
    const lines = [];
    lines.push(`<div class="prescriber-popup">`);
    lines.push(`<h3>${esc(p.name)}</h3>`);

    if (p.healthSystem) {
      lines.push(
        `<div class="health-system">${esc(p.healthSystem)}</div>`
      );
    }

    if (p.organization) {
      lines.push(`<div class="org">${esc(p.organization)}</div>`);
    }

    if (p.specialty || p.prescriberType) {
      lines.push(
        `<span class="badge badge-specialty">${esc(p.specialty || p.prescriberType)}</span>`
      );
    }

    if (p.address?.full) {
      lines.push(`<p class="detail">${esc(p.address.full)}</p>`);
    }

    if (p.phone) {
      lines.push(
        `<p class="detail">Phone: <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a></p>`
      );
    }

    if (p.email && !p.email.includes("@myeyes.net")) {
      lines.push(
        `<p class="detail">Email: <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></p>`
      );
    }

    if (p.npi) {
      lines.push(`<p class="detail">NPI: ${esc(p.npi)}</p>`);
    }

    if (p.distance != null) {
      lines.push(
        `<div class="distance">${p.distance.toFixed(1)} miles away</div>`
      );
    }

    // Verification badge
    if (p.verified) {
      lines.push(`<span class="badge badge-verified">Verified</span>`);
    } else if (p.address?.full) {
      lines.push(`<span class="badge badge-unverified">Unverified address</span>`);
    }

    lines.push(`</div>`);
    return lines.join("");
  }

  // -----------------------------------------------------------------------
  // Geocoding (Nominatim — free, no key needed)
  // -----------------------------------------------------------------------
  async function geocodeZip(zip) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { "User-Agent": "MyEyes-PrescriberMap/1.0" },
      });
      if (!res.ok) return null;
      const results = await res.json();
      if (results.length === 0) return null;
      return {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon),
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Haversine distance (miles)
  // -----------------------------------------------------------------------
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth radius in miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function esc(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
