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
  // Auth
  // -----------------------------------------------------------------------
  const PASS_HASH = "a0b1c8f4e6d2"; // lightweight check — not crypto-grade
  function checkPass(input) {
    return input === "myeyesmap";
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    const gate = document.getElementById("login-gate");
    const app = document.getElementById("app");
    const passInput = document.getElementById("login-password");
    const loginBtn = document.getElementById("login-btn");
    const loginErr = document.getElementById("login-error");

    // Already authenticated this session
    if (sessionStorage.getItem("myeyes-map-auth") === "1") {
      gate.classList.add("hidden");
      app.classList.remove("hidden");
      init();
      return;
    }

    function attemptLogin() {
      if (checkPass(passInput.value)) {
        sessionStorage.setItem("myeyes-map-auth", "1");
        gate.classList.add("hidden");
        app.classList.remove("hidden");
        init();
      } else {
        loginErr.textContent = "Incorrect password";
        passInput.value = "";
        passInput.focus();
      }
    }

    loginBtn.addEventListener("click", attemptLogin);
    passInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") attemptLogin();
    });
  });

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

      populateStateFilter();
      showPrescribers(allPrescribers);
    } catch (e) {
      console.error("Failed to load prescribers.json:", e);
      document.getElementById("data-info").textContent =
        "Error loading data. Run `npm run fetch` to generate prescribers.json.";
    } finally {
      document.getElementById("loading").classList.add("hidden");
    }
  }

  // State name → 2-letter code normalization
  const STATE_CODES = {
    ALABAMA:"AL",ALASKA:"AK",ARIZONA:"AZ",ARKANSAS:"AR",CALIFORNIA:"CA",
    COLORADO:"CO",CONNECTICUT:"CT",DELAWARE:"DE",FLORIDA:"FL",GEORGIA:"GA",
    HAWAII:"HI",IDAHO:"ID",ILLINOIS:"IL",INDIANA:"IN",IOWA:"IA",KANSAS:"KS",
    KENTUCKY:"KY",LOUISIANA:"LA",MAINE:"ME",MARYLAND:"MD",MASSACHUSETTS:"MA",
    MICHIGAN:"MI",MINNESOTA:"MN",MISSISSIPPI:"MS",MISSOURI:"MO",MONTANA:"MT",
    NEBRASKA:"NE",NEVADA:"NV","NEW HAMPSHIRE":"NH","NEW JERSEY":"NJ",
    "NEW MEXICO":"NM","NEW YORK":"NY","NORTH CAROLINA":"NC","NORTH DAKOTA":"ND",
    OHIO:"OH",OKLAHOMA:"OK",OREGON:"OR",PENNSYLVANIA:"PA","RHODE ISLAND":"RI",
    "SOUTH CAROLINA":"SC","SOUTH DAKOTA":"SD",TENNESSEE:"TN",TEXAS:"TX",
    UTAH:"UT",VERMONT:"VT",VIRGINIA:"VA",WASHINGTON:"WA","WEST VIRGINIA":"WV",
    WISCONSIN:"WI",WYOMING:"WY","DISTRICT OF COLUMBIA":"DC",
  };
  const VALID_CODES = new Set(Object.values(STATE_CODES));

  function normalizeState(raw) {
    if (!raw) return null;
    const upper = raw.trim().toUpperCase();
    // Already a valid 2-letter code
    if (VALID_CODES.has(upper)) return upper;
    // Full name → code
    if (STATE_CODES[upper]) return STATE_CODES[upper];
    return null; // Non-US or unrecognized — exclude
  }

  function populateStateFilter() {
    const states = [...new Set(
      allPrescribers
        .map((p) => normalizeState(p.address?.state))
        .filter(Boolean)
    )].sort();

    const select = document.getElementById("state-filter");
    const codeToName = {};
    for (const [name, code] of Object.entries(STATE_CODES)) codeToName[code] = name;

    states.forEach((code) => {
      const opt = document.createElement("option");
      opt.value = code;
      const fullName = codeToName[code];
      opt.textContent = fullName
        ? `${code} — ${fullName.charAt(0) + fullName.slice(1).toLowerCase()}`
        : code;
      select.appendChild(opt);
    });
  }

  function getFilteredPrescribers() {
    const state = document.getElementById("state-filter").value;
    if (!state) return allPrescribers;
    return allPrescribers.filter(
      (p) => normalizeState(p.address?.state) === state
    );
  }

  // -----------------------------------------------------------------------
  // Doctor name search
  // -----------------------------------------------------------------------
  function initDoctorSearch() {
    const input = document.getElementById("doctor-search");
    const resultsEl = document.getElementById("doctor-results");

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      if (query.length < 2) {
        resultsEl.classList.add("hidden");
        return;
      }

      const matches = allPrescribers
        .filter((p) => p.name && p.name.toLowerCase().includes(query))
        .slice(0, 20);

      if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="no-results">No doctors found</div>';
      } else {
        resultsEl.innerHTML = matches
          .map(
            (p, i) => `
          <div class="doctor-result-item" data-index="${i}">
            <div class="dr-name">${esc(p.name)}${p.specialty ? " <span class='badge badge-specialty'>" + esc(p.specialty) + "</span>" : ""}</div>
            <div class="dr-detail">${esc(p.organization || "")}${p.address?.city ? " — " + esc(p.address.city) + ", " + esc(p.address.state || "") : ""}</div>
          </div>`
          )
          .join("");

        resultsEl.querySelectorAll(".doctor-result-item").forEach((item, i) => {
          item.addEventListener("click", () => {
            selectDoctor(matches[i]);
            resultsEl.classList.add("hidden");
            input.value = matches[i].name;
          });
        });
      }

      resultsEl.classList.remove("hidden");
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".doctor-search-wrapper")) {
        resultsEl.classList.add("hidden");
      }
    });

    // Re-open on focus if there's a query
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= 2) {
        input.dispatchEvent(new Event("input"));
      }
    });
  }

  function selectDoctor(p) {
    if (!p.lat || !p.lng) {
      alert("This doctor does not have a mapped location.");
      return;
    }

    // Clear other filters
    document.getElementById("zip-input").value = "";
    document.getElementById("state-filter").value = "";
    searchLat = null;
    searchLng = null;
    if (searchCircle) {
      map.removeLayer(searchCircle);
      searchCircle = null;
    }

    // Show all prescribers on map but zoom to the selected one
    showPrescribers(allPrescribers);
    map.setView([p.lat, p.lng], 15);

    // Open the popup for this doctor's marker
    setTimeout(() => {
      markerCluster.eachLayer((layer) => {
        const ll = layer.getLatLng();
        if (
          Math.abs(ll.lat - p.lat) < 0.0001 &&
          Math.abs(ll.lng - p.lng) < 0.0001
        ) {
          layer.openPopup();
        }
      });
    }, 300);

    document.getElementById("result-count").textContent = `Selected: ${p.name}`;
  }

  function bindEvents() {
    document.getElementById("search-btn").addEventListener("click", doSearch);
    document.getElementById("clear-btn").addEventListener("click", clearSearch);
    document.getElementById("zip-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });
    document.getElementById("state-filter").addEventListener("change", applyStateFilter);
    initDoctorSearch();
  }

  function applyStateFilter() {
    const state = document.getElementById("state-filter").value;
    const filtered = getFilteredPrescribers();

    // Clear any active zip search
    searchLat = null;
    searchLng = null;
    if (searchCircle) {
      map.removeLayer(searchCircle);
      searchCircle = null;
    }
    document.getElementById("result-count").textContent = state
      ? `${filtered.length} prescriber${filtered.length !== 1 ? "s" : ""} in ${state}`
      : "";

    showPrescribers(filtered, !!state);

    // Zoom to fit the filtered markers
    if (state) {
      const withCoords = filtered.filter((p) => p.lat && p.lng);
      if (withCoords.length > 0) {
        const bounds = L.latLngBounds(withCoords.map((p) => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    } else {
      map.setView([39.8, -98.5], 4);
    }
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

    // Filter prescribers within radius (respect state filter if set)
    const base = getFilteredPrescribers();
    const nearby = base
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
    document.getElementById("state-filter").value = "";
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
