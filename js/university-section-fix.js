import { db } from "./config.js";

const params = new URLSearchParams(window.location.search);
const propertyId = params.get("id");
let loading = false;

function formatDistanceMeters(meters){
  const m = Number(meters);
  if(!Number.isFinite(m) || m < 0) return "";
  if(m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

function findSectionByTitle(title){
  return [...document.querySelectorAll("#detailRoot .detail-section")].find(section => {
    const heading = section.querySelector("h2");
    return (heading?.textContent || "").trim() === title;
  }) || null;
}

function removeLocationMessages(){
  document.querySelectorAll("#detailRoot .protected-location-public").forEach(el => el.remove());
  document.querySelectorAll("#detailRoot .tiny-note").forEach(el => {
    const text = (el.textContent || "").toLowerCase();
    if(
      text.includes("localização precisa") ||
      text.includes("endereço exato") ||
      text.includes("coordenadas do imóvel")
    ) el.remove();
  });
}

function moveUniversitySectionToCorrectPlace(){
  const config = findSectionByTitle("Configuração e acesso");
  const university = findSectionByTitle("Faculdades próximas");
  if(!config || !university) return false;
  if(config.nextElementSibling !== university){
    config.insertAdjacentElement("afterend", university);
  }
  return true;
}

function buildUniversitySection(rows){
  const section = document.createElement("section");
  section.className = "detail-section university-distance-section";

  const titleRow = document.createElement("div");
  titleRow.className = "section-title-row";
  const titleWrap = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "Faculdades próximas";
  titleWrap.appendChild(h2);
  titleRow.appendChild(titleWrap);
  section.appendChild(titleRow);

  const list = document.createElement("div");
  list.className = "university-list";

  rows.forEach(item => {
    const row = document.createElement("div");
    row.className = "university-row";

    const info = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = item.university_name || "Faculdade";
    info.appendChild(strong);

    if(item.university_address){
      const address = document.createElement("span");
      address.textContent = item.university_address;
      info.appendChild(address);
    }

    const distance = formatDistanceMeters(item.distance_m);
    if(distance){
      const distanceNode = document.createElement("div");
      distanceNode.className = "university-distance";
      distanceNode.textContent = `📍 Aproximadamente ${distance} do imóvel`;
      info.appendChild(distanceNode);
    }

    row.appendChild(info);

    const mapsUrl = String(item.university_maps_url || "").trim();
    if(mapsUrl){
      const actions = document.createElement("div");
      actions.className = "route-modes";
      const link = document.createElement("a");
      link.className = "btn ghost compact";
      link.href = mapsUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Ver faculdade no mapa";
      actions.appendChild(link);
      row.appendChild(actions);
    }

    list.appendChild(row);
  });

  section.appendChild(list);
  return section;
}

async function ensureUniversities(){
  removeLocationMessages();

  if(moveUniversitySectionToCorrectPlace()) return;
  if(!propertyId || loading) return;

  const config = findSectionByTitle("Configuração e acesso");
  if(!config) return;

  loading = true;
  try{
    const { data, error } = await db.rpc("get_public_property_university_distances", {
      p_property_id: propertyId
    });
    if(error || !Array.isArray(data) || !data.length) return;

    const old = findSectionByTitle("Faculdades próximas");
    if(old) old.remove();

    const section = buildUniversitySection(data);
    config.insertAdjacentElement("afterend", section);
  }catch(err){
    console.warn("Não foi possível restaurar a seção de faculdades:", err);
  }finally{
    loading = false;
    removeLocationMessages();
    moveUniversitySectionToCorrectPlace();
  }
}

const root = document.querySelector("#detailRoot");
if(root){
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(ensureUniversities, 40);
  });
  observer.observe(root, { childList: true, subtree: true });
}

ensureUniversities();
setTimeout(ensureUniversities, 300);
setTimeout(ensureUniversities, 1000);
