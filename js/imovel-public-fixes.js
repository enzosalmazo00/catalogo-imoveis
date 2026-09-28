/* Ajustes públicos da página do imóvel — 28/09/2026 */

function distanceToMeters(text = "") {
  const normalized = String(text).replace(/\s+/g, " ");
  const km = normalized.match(/([0-9]+(?:[.,][0-9]+)?)\s*km\b/i);
  if (km) return Number(km[1].replace(",", ".")) * 1000;
  const m = normalized.match(/([0-9]+(?:[.,][0-9]+)?)\s*m\b/i);
  if (m) return Number(m[1].replace(",", "."));
  return Number.POSITIVE_INFINITY;
}

function cleanDistanceText(text = "") {
  return String(text)
    .replace(/^\s*📍\s*/u, "")
    .replace(/^Aproximadamente\s+/i, "")
    .replace(/\s+do imóvel\s*$/i, "")
    .trim();
}

function removeLocationPrivacyMessages(root = document) {
  root.querySelectorAll(".protected-location-public").forEach(el => el.remove());

  root.querySelectorAll(".university-list").forEach(list => {
    const section = list.closest(".detail-section");
    section?.querySelectorAll(".tiny-note").forEach(note => note.remove());
  });

  root.querySelectorAll(".detail-section p, .tiny-note").forEach(el => {
    const text = (el.textContent || "").toLowerCase();
    if (
      text.includes("endereço exato não é exibido") ||
      text.includes("coordenadas do imóvel não são exibidas") ||
      text.includes("localização precisa é utilizada somente")
    ) {
      const section = el.closest(".protected-location-public");
      (section || el).remove();
    }
  });
}

function addNearestUniversityToMainPhoto(root = document) {
  const shell = root.querySelector(".main-photo-shell");
  const list = root.querySelector(".university-list");
  if (!shell || !list) return false;

  const candidates = [...list.querySelectorAll(".university-row")]
    .map(row => {
      const name = (row.querySelector("strong")?.textContent || "").trim();
      const distanceNode = row.querySelector(".university-distance");
      const rawDistance = (distanceNode?.textContent || "").trim();
      return {
        name,
        distance: cleanDistanceText(rawDistance),
        meters: distanceToMeters(rawDistance)
      };
    })
    .filter(item => item.name && item.distance && Number.isFinite(item.meters))
    .sort((a, b) => a.meters - b.meters);

  const nearest = candidates[0];
  if (!nearest) return false;

  const desiredText = `🎓 ${nearest.distance} da ${nearest.name}`;
  const desiredTitle = `${nearest.distance} da ${nearest.name}`;
  let badge = shell.querySelector(".detail-nearest-university-pill");

  if (!badge) {
    badge = document.createElement("div");
    badge.className = "detail-nearest-university-pill";
    shell.appendChild(badge);
  }

  if (badge.textContent !== desiredText) badge.textContent = desiredText;
  if (badge.title !== desiredTitle) badge.title = desiredTitle;
  return true;
}

function applyPublicFixes() {
  const root = document.querySelector("#detailRoot") || document;
  removeLocationPrivacyMessages(root);
  return addNearestUniversityToMainPhoto(root);
}

const detailRoot = document.querySelector("#detailRoot");
let scheduled = false;

if (detailRoot) {
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyPublicFixes();
    });
  });
  observer.observe(detailRoot, { childList: true, subtree: true });
}

applyPublicFixes();
setTimeout(applyPublicFixes, 250);
setTimeout(applyPublicFixes, 800);
