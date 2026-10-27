"use strict";

/* =========================================
   CYBERTRACE | OSINT INVESTIGATION DASHBOARD
   ========================================== */

const CONFIG = {
  storageKey: "cybertrace_workspace_v1",
  nominatim: "https://nominatim.openstreetmap.org/search",
  ipApi: "https://ipapi.co",
  dnsApi: "https://cloudflare-dns.com/dns-query",
  commonsApi: "https://commons.wikimedia.org/w/api.php"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  Array.from(root.querySelectorAll(selector));

const makeId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36).slice(2, 7)}`;

const timestamp = () => new Date().toISOString();

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function loadWorkspace() {
  const defaults = {
    cases: [],
    evidence: [],
    history: [],
    savedLocations: [],
    lastLocation: null
  };

  try {
    const stored = JSON.parse(localStorage.getItem(CONFIG.storageKey));
    return stored && typeof stored === "object"
      ? { ...defaults, ...stored }
      : defaults;
  } catch {
    return defaults;
  }
}

let workspace = loadWorkspace();
let map = null;
let mapMarker = null;
let mapResultsLayer = null;
let currentLocationResults = [];
let activeLocation = null;

function persist() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(workspace));
    updateDashboard();
    return true;
  } catch {
    notify(
      "Storage full or unavailable. Export your reports and remove old records.",
      "error"
    );
    return false;
  }
}

function notify(message, type = "success") {
  let container = $(".toast-container");

  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    container.setAttribute("role", "status");
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), 4500);
}

function setLoading(button, loading, label = "Working...") {
  if (!button) return;

  if (loading) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    button.textContent =
      button.dataset.originalText || button.textContent;
    delete button.dataset.originalText;
  }
}

function addHistory(type, query, details = {}) {
  workspace.history.unshift({
    id: makeId("history"),
    type,
    query: String(query || ""),
    details,
    createdAt: timestamp()
  });

  workspace.history = workspace.history.slice(0, 300);
  persist();
  renderHistory();
}

function formatDate(value) {
  if (!value) return "Unknown";

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString();
}

/* ==========================================
   NAVIGATION
   ========================================== */

$$("[data-section]").forEach((link) => {
  link.addEventListener("click", (event) => {
    const sectionName = link.dataset.section;
    const target = document.getElementById(sectionName);

    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });

    $$(".sidebar nav a").forEach((item) => {
      item.classList.toggle("active", item === link);
    });
  });
});

/* ==========================================
   MAP
   ========================================== */

function initializeMap() {
  const mapElement = $("#location-map");

  if (!mapElement) {
    console.warn("Map element #location-map was not found.");
    return;
  }

  if (typeof L === "undefined") {
    mapElement.innerHTML =
      '<div class="map-placeholder">Map library unavailable. Check your internet connection.</div>';
    return;
  }

  map = L.map(mapElement).setView([24.8607, 67.0011], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  }).addTo(map);

  mapResultsLayer = L.layerGroup().addTo(map);

  map.on("click", (event) => {
    const location = {
      name: "Manually selected map point",
      lat: event.latlng.lat,
      lon: event.latlng.lng,
      source: "User-selected map point"
    };

    showLocation(location, true);
  });

  if (workspace.lastLocation) {
    showLocation(workspace.lastLocation, false);
  }

  setTimeout(() => map.invalidateSize(), 300);
}

function showLocation(location, addToHistory = false) {
  if (!location || !Number.isFinite(Number(location.lat)) ||
      !Number.isFinite(Number(location.lon))) {
    notify("Invalid coordinates.", "error");
    return;
  }

  const lat = Number(location.lat);
  const lon = Number(location.lon);

  activeLocation = {
    name: location.name || "Selected location",
    lat,
    lon,
    source: location.source || "OpenStreetMap",
    address: location.address || ""
  };

  workspace.lastLocation = activeLocation;
  persist();

  const latElement = $("#latitude");
  const lonElement = $("#longitude");
  const nameElement = $("#selected-location");

  if (latElement) latElement.textContent = lat.toFixed(6);
  if (lonElement) lonElement.textContent = lon.toFixed(6);
  if (nameElement) nameElement.textContent = activeLocation.name;

  if (map) {
    map.setView([lat, lon], 14);

    if (mapMarker) map.removeLayer(mapMarker);

    mapMarker = L.marker([lat, lon])
      .addTo(map)
      .bindPopup(escapeHTML(activeLocation.name))
      .openPopup();
  }

  const googleButton = $("#google-maps-button");
  if (googleButton) {
    googleButton.dataset.url =
      `https://www.google.com/maps?q=${lat},${lon}`;
  }

  const coordinates = $("#coordinates");
  if (coordinates) {
    coordinates.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }

  if (addToHistory) {
    addHistory("Map point", activeLocation.name, {
      latitude: lat,
      longitude: lon
    });
  }
}

/* ==========================================
   GEOSPATIAL SEARCH
   ========================================== */

const locationForm = $("#location-form");

if (locationForm) {
  locationForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = $("#location-query");
    const query = input?.value.trim();

    if (!query) {
      notify("Enter a place, address, landmark or area.", "error");
      return;
    }

    const button = $('button[type="submit"]', locationForm);
    setLoading(button, true, "Searching...");

    try {
      const url = new URL(CONFIG.nominatim);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "8");
      url.searchParams.set("addressdetails", "1");

      const response = await fetch(url, {
        headers: { "Accept": "application/json" }
      });

      if (!response.ok) {
        throw new Error(`Search service returned ${response.status}`);
      }

      const results = await response.json();
      currentLocationResults = results;

      renderLocationResults(results);
      addHistory("Geospatial search", query, {
        resultCount: results.length
      });

      if (results.length) {
        showLocation({
          name: results[0].display_name,
          lat: Number(results[0].lat),
          lon: Number(results[0].lon),
          address: results[0].display_name,
          source: "OpenStreetMap Nominatim"
        });
      } else {
        notify("No matching locations found.", "error");
      }
    } catch (error) {
      console.error(error);
      notify(
        "Location search failed. Check internet access and try again.",
        "error"
      );
    } finally {
      setLoading(button, false);
    }
  });
}

function renderLocationResults(results) {
  const container = $("#location-results");
  if (!container) return;

  if (!results.length) {
    container.innerHTML =
      '<div class="empty-state"><strong>No results</strong>Try a different place name.</div>';
    return;
  }

  container.innerHTML = results.map((item, index) => `
    <article class="result-item">
      <h4>${escapeHTML(item.display_name)}</h4>
      <p>Coordinates: <span class="mono">${Number(item.lat).toFixed(6)}, ${Number(item.lon).toFixed(6)}</span></p>
      <p>Source: OpenStreetMap Nominatim</p>
      <div class="button-row">
        <button class="btn btn-secondary btn-small"
          data-action="select-location" data-index="${index}">
          Show on map
        </button>
        <button class="btn btn-secondary btn-small"
          data-action="save-result" data-index="${index}">
          Save location
        </button>
      </div>
    </article>
  `).join("");
}

$("#location-results")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const item = currentLocationResults[Number(button.dataset.index)];
  if (!item) return;

  const location = {
    name: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon),
    address: item.display_name,
    source: "OpenStreetMap Nominatim"
  };

  if (button.dataset.action === "select-location") {
    showLocation(location, true);
  }

  if (button.dataset.action === "save-result") {
    saveLocation(location);
  }
});

$("#clear-location")?.addEventListener("click", () => {
  const input = $("#location-query");
  if (input) input.value = "";

  const results = $("#location-results");
  if (results) results.innerHTML = "";

  currentLocationResults = [];
});

$("#google-maps-button")?.addEventListener("click", () => {
  if (!activeLocation) {
    notify("Select a location first.", "error");
    return;
  }

  const url =
    `https://www.google.com/maps?q=${activeLocation.lat},${activeLocation.lon}`;

  window.open(url, "_blank", "noopener,noreferrer");
});

$("#copy-coordinates")?.addEventListener("click", async () => {
  if (!activeLocation) {
    notify("Select a location first.", "error");
    return;
  }

  const text =
    `${activeLocation.lat.toFixed(6)}, ${activeLocation.lon.toFixed(6)}`;

  try {
    await navigator.clipboard.writeText(text);
    notify("Coordinates copied.");
  } catch {
    notify(`Coordinates: ${text}`, "error");
  }
});

function saveLocation(location) {
  const duplicate = workspace.savedLocations.some((item) =>
    item.lat === location.lat && item.lon === location.lon
  );

  if (duplicate) {
    notify("This location is already saved.", "error");
    return;
  }

  workspace.savedLocations.push({
    id: makeId("location"),
    ...location,
    savedAt: timestamp()
  });

  persist();
  notify("Location saved to your local workspace.");
}

$("#save-location")?.addEventListener("click", () => {
  if (!activeLocation) {
    notify("Select a location first.", "error");
    return;
  }

  saveLocation(activeLocation);
});

/* ==========================================
   IP INTELLIGENCE
   ========================================== */

const ipForm = $("#ip-form");

if (ipForm) {
  ipForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = $("#ip-query");
    const ip = input?.value.trim() || "";

    if (ip && !isValidIP(ip)) {
      notify("Enter a valid IPv4 or IPv6 address.", "error");
      return;
    }

    const button = $('button[type="submit"]', ipForm);
    setLoading(button, true, "Looking up...");

    try {
      const endpoint = ip
        ? `${CONFIG.ipApi}/${encodeURIComponent(ip)}/json/`
        : `${CONFIG.ipApi}/json/`;

      const response = await fetch(endpoint);

      if (!response.ok) {
        throw new Error("IP lookup service failed.");
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.reason || "IP lookup failed.");
      }

      renderIPResult(data);
      addHistory("IP lookup", data.ip || ip || "Public IP", {
        country: data.country_name || "",
        city: data.city || ""
      });
    } catch (error) {
      console.error(error);
      notify(
        "IP lookup failed. The service may be unavailable or rate-limited.",
        "error"
      );
    } finally {
      setLoading(button, false);
    }
  });
}

function isValidIP(value) {
  const ipv4 =
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

  const ipv6 = /^(?=.*:)[0-9a-fA-F:]+$/;

  return ipv4.test(value) ||
    (value.includes(":") && ipv6.test(value) && value.length <= 45);
}

function renderIPResult(data) {
  const container = $("#ip-results");
  if (!container) return;

  const fields = [
    ["IP Address", data.ip],
    ["Version", data.version],
    ["City", data.city],
    ["Region", data.region],
    ["Country", data.country_name],
    ["Country Code", data.country_code],
    ["Postal Code", data.postal],
    ["Approximate Latitude", data.latitude],
    ["Approximate Longitude", data.longitude],
    ["ISP / Organization", data.org],
    ["ASN", data.asn],
    ["Timezone", data.timezone]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  container.innerHTML = `
    <div class="result-item">
      <h4>IP Intelligence Result</h4>
      <p>Source: ipapi.co</p>
      <div class="table-wrap" style="margin-top:12px">
        <table>
          <tbody>
            ${fields.map(([label, value]) => `
              <tr>
                <th>${escapeHTML(label)}</th>
                <td>${escapeHTML(value)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="notice notice-warning">
        IP geolocation is approximate and does not identify an exact home,
        person, device location or real-time movement.
      </div>
      ${Number.isFinite(Number(data.latitude)) &&
        Number.isFinite(Number(data.longitude)) ? `
        <div class="button-row">
          <button class="btn btn-secondary btn-small"
            data-action="show-ip-map"
            data-lat="${Number(data.latitude)}"
            data-lon="${Number(data.longitude)}"
            data-name="${escapeHTML(`${data.city || ""}, ${data.country_name || ""}`)}">
            Show approximate area on map
          </button>
        </div>` : ""}
    </div>
  `;
}

$("#ip-results")?.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="show-ip-map"]');
  if (!button) return;

  showLocation({
    name: button.dataset.name || "Approximate IP location",
    lat: Number(button.dataset.lat),
    lon: Number(button.dataset.lon),
    source: "Approximate IP geolocation"
  }, true);

  $("#geospatial")?.scrollIntoView({ behavior: "smooth" });
});

/* ==========================================
   DOMAIN DNS INTELLIGENCE
   ========================================== */

const domainForm = $("#domain-form");

if (domainForm) {
  domainForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = $("#domain-query");
    const domain = (input?.value || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .toLowerCase();

    if (!isValidDomain(domain)) {
      notify("Enter a valid domain, e.g. example.com", "error");
      return;
    }

    const button = $('button[type="submit"]', domainForm);
    setLoading(button, true, "Checking DNS...");

    try {
      const types = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"];
      const records = await Promise.all(
        types.map(async (type) => {
          try {
            const url = new URL(CONFIG.dnsApi);
            url.searchParams.set("name", domain);
            url.searchParams.set("type", type);

            const response = await fetch(url, {
              headers: { "Accept": "application/dns-json" }
            });

            if (!response.ok) throw new Error("DNS request failed");

            const data = await response.json();

            return {
              type,
              status: data.Status,
              answers: (data.Answer || []).map((answer) => ({
                name: answer.name,
                type: answer.type,
                data: answer.data,
                ttl: answer.TTL
              }))
            };
          } catch {
            return { type, status: null, answers: [] };
          }
        })
      );

      renderDomainResult(domain, records);
      addHistory("Domain DNS lookup", domain, {
        recordTypes: types
      });
    } catch (error) {
      console.error(error);
      notify("DNS lookup failed. Check your internet connection.", "error");
    } finally {
      setLoading(button, false);
    }
  });
}

function isValidDomain(domain) {
  if (domain.length > 253 || domain.length < 3) return false;
  if (domain.includes(" ") || !domain.includes(".")) return false;

  return domain.split(".").every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

function renderDomainResult(domain, records) {
  const container = $("#domain-results");
  if (!container) return;

  container.innerHTML = `
    <div class="result-item">
      <h4>DNS Results: ${escapeHTML(domain)}</h4>
      <p>Source: Cloudflare DNS over HTTPS</p>
      ${records.map((record) => `
        <div class="divider"></div>
        <h4>${escapeHTML(record.type)} Records</h4>
        ${record.answers.length
          ? `<div class="table-wrap" style="margin-top:8px">
              <table>
                <thead><tr><th>Record</th><th>TTL</th></tr></thead>
                <tbody>
                  ${record.answers.map((answer) => `
                    <tr>
                      <td class="mono">${escapeHTML(answer.data)}</td>
                      <td>${escapeHTML(answer.ttl)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>`
          : '<p>No records returned for this type.</p>'}
      `).join("")}
      <div class="notice">
        DNS results describe publicly returned DNS records; they do not prove
        ownership, compromise or malicious activity.
      </div>
    </div>
  `;
}

/* ==========================================
   WIKIMEDIA COMMONS IMAGE SEARCH
   ========================================== */

async function searchCommons(query) {
  const url = new URL(CONFIG.commonsApi);

  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "12");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("iiurlwidth", "400");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const response = await fetch(url);

  if (!response.ok) throw new Error("Image search failed.");

  const data = await response.json();
  return Object.values(data.query?.pages || {});
}

function renderGallery(items) {
  const container = $("#gallery-content");
  if (!container) return;

  if (!items.length) {
    container.innerHTML =
      '<div class="empty-state"><strong>No images found</strong>Try another search phrase.</div>';
    return;
  }

  container.innerHTML = items.map((item) => {
    const info = item.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    const imageURL = safeURL(info.thumburl || info.url);
    const pageURL = safeURL(info.descriptionurl);
    const title = item.title || "Untitled image";
    const author = meta.Artist?.value || "Author not listed";
    const license = meta.LicenseShortName?.value || "License not listed";
    const description = meta.ImageDescription?.value || "";

    if (!imageURL || !pageURL) return "";

    return `
      <article class="gallery-card">
        <a href="${escapeHTML(pageURL)}" target="_blank" rel="noopener noreferrer">
          <img src="${escapeHTML(imageURL)}"
            alt="${escapeHTML(title)}"
            loading="lazy">
        </a>
        <div class="gallery-card-body">
          <h4>${escapeHTML(title.replace(/^File:/, ""))}</h4>
          <p>Author: ${escapeHTML(author.replace(/<[^>]*>/g, ""))}</p>
          <p>License: ${escapeHTML(license.replace(/<[^>]*>/g, ""))}</p>
          <p>Source: Wikimedia Commons</p>
          ${description ? `<p>${escapeHTML(description.replace(/<[^>]*>/g, "").slice(0, 180))}</p>` : ""}
          <div class="button-row">
            <a class="btn btn-secondary btn-small"
              href="${escapeHTML(pageURL)}"
              target="_blank" rel="noopener noreferrer">Source page</a>
            <button class="btn btn-secondary btn-small"
              data-action="save-image"
              data-title="${escapeHTML(title)}"
              data-url="${escapeHTML(pageURL)}"
              data-author="${escapeHTML(author.replace(/<[^>]*>/g, ""))}"
              data-license="${escapeHTML(license.replace(/<[^>]*>/g, ""))}">
              Save reference
            </button>
          </div>
        </div>
      </article>
    `;
  }).join("") || '<div class="empty-state">No usable image results.</div>';
}

const galleryForm = $("#image-form") || $("#gallery-form");

if (galleryForm) {
  galleryForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = $("#image-query") || $("#gallery-query");
    const query = input?.value.trim();

    if (!query) {
      notify("Enter a keyword or place to search images.", "error");
      return;
    }

    const button = $('button[type="submit"]', galleryForm);
    setLoading(button, true, "Searching images...");

    try {
      const results = await searchCommons(query);
      renderGallery(results);
      addHistory("Image search", query, {
        resultCount: results.length
      });
    } catch (error) {
      console.error(error);

      const container = $("#gallery-content");
      if (container) {
        container.innerHTML =
          '<div class="empty-state"><strong>Image search unavailable</strong>Check your connection and try again.</div>';
      }

      notify("Could not retrieve images.", "error");
    } finally {
      setLoading(button, false);
    }
  });
}

$("#gallery-content")?.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="save-image"]');
  if (!button) return;

  const record = {
    id: makeId("evidence"),
    type: "Image reference",
    title: button.dataset.title || "Image",
    sourceURL: button.dataset.url || "",
    description: `Author: ${button.dataset.author || "Not listed"}; License: ${button.dataset.license || "Not listed"}`,
    caseId: "",
    location: activeLocation?.name || "",
    latitude: activeLocation?.lat ?? null,
    longitude: activeLocation?.lon ?? null,
    notes: "Image reference saved from Wikimedia Commons.",
    collectedAt: timestamp()
  };

  workspace.evidence.unshift(record);
  persist();
  renderEvidence();
  notify("Image reference saved to the evidence register.");
});

/* ==========================================
   CASE MANAGEMENT
   ========================================== */

const caseForm = $("#case-form");

if (caseForm) {
  caseForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const title = getFieldValue(caseForm, [
      "case-title", "case-name", "title"
    ]);

    const objective = getFieldValue(caseForm, [
      "case-objective", "case-description", "objective"
    ]);

    if (!title) {
      notify("Enter a case title.", "error");
      return;
    }

    const caseRecord = {
      id: makeId("CT"),
      title,
      objective,
      location: getFieldValue(caseForm, [
        "case-location", "location"
      ]) || activeLocation?.name || "",
      status: getFieldValue(caseForm, [
        "case-status", "status"
      ]) || "Open",
      createdAt: timestamp(),
      updatedAt: timestamp(),
      notes: getFieldValue(caseForm, ["case-notes", "notes"]),
      searchHistory: [],
      coordinates: activeLocation ? {
        lat: activeLocation.lat,
        lon: activeLocation.lon
      } : null
    };

    workspace.cases.unshift(caseRecord);
    persist();
    renderCases();
    updateCaseSelects();
    caseForm.reset();

    notify(`Case created: ${caseRecord.id}`);
  });
}

function getFieldValue(form, names) {
  for (const name of names) {
    const element =
      form.querySelector(`#${CSS.escape(name)}`) ||
      form.querySelector(`[name="${CSS.escape(name)}"]`);

    if (element && "value" in element) {
      return element.value.trim();
    }
  }

  return "";
}

function renderCases() {
  const container = $("#case-list");
  if (!container) return;

  if (!workspace.cases.length) {
    container.innerHTML =
      '<div class="empty-state"><strong>No cases yet</strong>Create a case to organize your investigation.</div>';
    return;
  }

  container.innerHTML = workspace.cases.map((record) => `
    <article class="result-item">
      <div class="panel-header">
        <h4>${escapeHTML(record.title)}</h4>
        <span class="badge">${escapeHTML(record.status || "Open")}</span>
      </div>
      <p>Case ID: <span class="mono">${escapeHTML(record.id)}</span></p>
      <p>Created: ${escapeHTML(formatDate(record.createdAt))}</p>
      <p>Objective: ${escapeHTML(record.objective || "Not specified")}</p>
      <p>Location: ${escapeHTML(record.location || "Not specified")}</p>
      ${record.coordinates ? `<p>Coordinates: ${record.coordinates.lat}, ${record.coordinates.lon}</p>` : ""}
      <div class="button-row">
        <button class="btn btn-secondary btn-small"
          data-action="case-report" data-id="${escapeHTML(record.id)}">View report</button>
        <button class="btn btn-danger btn-small"
          data-action="delete-case" data-id="${escapeHTML(record.id)}">Delete case</button>
      </div>
    </article>
  `).join("");
}

$("#case-list")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = button.dataset.id;

  if (button.dataset.action === "delete-case") {
    const associated = workspace.evidence.some((item) => item.caseId === id);

    if (associated && !confirm(
      "This case has associated evidence. Delete the case and unlink that evidence?"
    )) return;

    workspace.cases = workspace.cases.filter((item) => item.id !== id);
    workspace.evidence = workspace.evidence.map((item) =>
      item.caseId === id ? { ...item, caseId: "" } : item
    );

    persist();
    renderCases();
    renderEvidence();
    updateCaseSelects();
    notify("Case deleted; evidence records were retained.");
  }

  if (button.dataset.action === "case-report") {
    const record = workspace.cases.find((item) => item.id === id);
    if (record) showReport(record);
  }
});

/* ==========================================
   EVIDENCE, HISTORY, CASE SELECTS & REPORTS
   ========================================== */
function renderEvidence() {
  const container = $("#evidence-list");
  if (!container) return;
  if (!workspace.evidence.length) {
    container.innerHTML = '<div class="empty-state"><strong>No evidence saved</strong>Save an image reference to start an evidence register.</div>';
    return;
  }
  container.innerHTML = workspace.evidence.map((item) => `
    <article class="result-item">
      <div class="panel-header"><h4>${escapeHTML(item.title || item.type || "Evidence")}</h4><span class="badge">${escapeHTML(item.type || "Record")}</span></div>
      <p>${escapeHTML(item.description || item.notes || "No description")}</p>
      <p>Case: ${escapeHTML(workspace.cases.find(c => c.id === item.caseId)?.title || "Unassigned")}</p>
      <p>Collected: ${escapeHTML(formatDate(item.collectedAt))}</p>
      ${safeURL(item.sourceURL) ? `<p><a href="${escapeHTML(safeURL(item.sourceURL))}" target="_blank" rel="noopener noreferrer">Open source</a></p>` : ""}
      <div class="button-row"><button class="btn btn-danger btn-small" data-action="delete-evidence" data-id="${escapeHTML(item.id)}">Remove evidence</button></div>
    </article>`).join("");
}

$("#evidence-list")?.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="delete-evidence"]');
  if (!button) return;
  workspace.evidence = workspace.evidence.filter(item => item.id !== button.dataset.id);
  persist(); renderEvidence(); notify("Evidence record removed.");
});

function renderHistory() {
  const container = $("#history-list");
  if (!container) return;
  if (!workspace.history.length) {
    container.innerHTML = '<div class="empty-state"><strong>No activity yet</strong>Your searches and investigation actions will appear here.</div>';
    return;
  }
  container.innerHTML = workspace.history.slice(0, 100).map(item => `
    <article class="history-row"><span class="history-dot"></span><div><strong>${escapeHTML(item.type || "Activity")}</strong><p>${escapeHTML(item.query || "No query")}</p><small>${escapeHTML(formatDate(item.createdAt))}</small></div></article>`).join("");
}

function updateCaseSelects() {
  const selects = $$("select[data-case-select], #evidence-case, #report-case");
  selects.forEach(select => {
    const previous = select.value;
    select.innerHTML = '<option value="">Unassigned / select a case</option>' + workspace.cases.map(record => `<option value="${escapeHTML(record.id)}">${escapeHTML(record.title)}</option>`).join("");
    if (workspace.cases.some(record => record.id === previous)) select.value = previous;
  });
}

function showReport(record) {
  const report = `CYBERTRACE INVESTIGATION REPORT\n================================\nCase ID: ${record.id}\nTitle: ${record.title}\nStatus: ${record.status || "Open"}\nCreated: ${formatDate(record.createdAt)}\nUpdated: ${formatDate(record.updatedAt)}\nLocation: ${record.location || "Not specified"}\nObjective: ${record.objective || "Not specified"}\nNotes: ${record.notes || "None"}\n\nAssociated evidence: ${workspace.evidence.filter(item => item.caseId === record.id).length}\nGenerated: ${formatDate(timestamp())}`;
  const modal = $("#report-modal");
  const body = $("#report-content");
  if (modal && body) { body.textContent = report; modal.hidden = false; }
  else { downloadText(`cybertrace-${record.id}-report.txt`, report, "text/plain;charset=utf-8"); }
}

function downloadText(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#close-report")?.addEventListener("click", () => { const modal = $("#report-modal"); if (modal) modal.hidden = true; });
$("#download-report")?.addEventListener("click", () => {
  const content = $("#report-content")?.textContent || "No report available.";
  downloadText("cybertrace-investigation-report.txt", content, "text/plain;charset=utf-8");
});
$("#clear-history")?.addEventListener("click", () => {
  if (!confirm("Clear activity history?")) return;
  workspace.history = []; persist(); renderHistory(); notify("Activity history cleared.");
});


/* ==========================================
   DASHBOARD STATISTICS
   ========================================== */

function updateDashboard() {
  const values = {
    cases: workspace.cases.length,
    evidence: workspace.evidence.length,
    searches: workspace.history.length,
    locations: workspace.savedLocations.length
  };

  const possibleIds = {
    cases: ["total-cases", "stat-cases", "case-count"],
    evidence: ["total-evidence", "stat-evidence", "evidence-count"],
    searches: ["total-searches", "stat-searches", "search-count"],
    locations: ["total-locations", "stat-locations", "location-count"]
  };

  Object.entries(possibleIds).forEach(([key, ids]) => {
    ids.forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.textContent = values[key];
    });
  });
}

/* ==========================================
   EXPORT / IMPORT LOCAL WORKSPACE
   ========================================== */

$("#export-data")?.addEventListener("click", () => {
  downloadText(
    "cybertrace-workspace.json",
    JSON.stringify(workspace, null, 2),
    "application/json;charset=utf-8"
  );

  notify("Workspace exported.");
});

$("#import-data")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const imported = JSON.parse(await file.text());

    if (!imported || !Array.isArray(imported.cases) ||
        !Array.isArray(imported.evidence) ||
        !Array.isArray(imported.history)) {
      throw new Error("Invalid workspace format.");
    }

    if (!confirm("Importing replaces the current local workspace. Continue?")) {
      event.target.value = "";
      return;
    }

    workspace = {
      cases: imported.cases,
      evidence: imported.evidence,
      history: imported.history,
      savedLocations: Array.isArray(imported.savedLocations)
        ? imported.savedLocations : [],
      lastLocation: imported.lastLocation || null
    };

    persist();
    renderCases();
    renderEvidence();
    renderHistory();
    updateCaseSelects();

    if (workspace.lastLocation) {
      showLocation(workspace.lastLocation);
    }

    notify("Workspace imported successfully.");
  } catch (error) {
    console.error(error);
    notify("Import failed. Choose a valid CyberTrace JSON export.", "error");
  } finally {
    event.target.value = "";
  }
});
/* ==========================================
   SETTINGS
   ========================================== */

$("#clear-workspace")?.addEventListener("click", () => {
  if (!confirm(
    "This permanently clears cases, evidence, history and saved locations from this browser. Export a backup first if needed. Continue?"
  )) return;

  workspace = {
    cases: [],
    evidence: [],
    history: [],
    savedLocations: [],
    lastLocation: null
  };

  persist();
  renderCases();
  renderEvidence();
  renderHistory();
  updateCaseSelects();

  if ($("#location-results")) {
    $("#location-results").innerHTML = "";
  }

  if ($("#ip-results")) $("#ip-results").innerHTML = "";
  if ($("#domain-results")) $("#domain-results").innerHTML = "";
  if ($("#gallery-content")) $("#gallery-content").innerHTML = "";

  if (mapMarker && map) {
    map.removeLayer(mapMarker);
    mapMarker = null;
  }

  activeLocation = null;
  notify("Local workspace cleared.");
});

/* ==========================================
   INITIALIZE APP
   ========================================== */

function initializeCyberTrace() {
  initializeMap();
  renderCases();
  renderEvidence();
  renderHistory();
  updateCaseSelects();
  updateDashboard();

  console.log("CyberTrace initialized.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeCyberTrace);
} else {
  initializeCyberTrace();
}
