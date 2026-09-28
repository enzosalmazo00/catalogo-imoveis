import { db } from "./config.js";

const params=new URLSearchParams(window.location.search);
const propertyId=params.get("id");
let rowsCache=null;
let loading=false;

function esc(value=""){
  return String(value).replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function formatDistanceMeters(meters){
  const m=Number(meters);
  if(!Number.isFinite(m)||m<0) return "";
  if(m<1000) return `${Math.max(10,Math.round(m/10)*10)} m`;
  return `${(m/1000).toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;
}

function findSection(title){
  return [...document.querySelectorAll("#detailRoot .detail-section")].find(section=>
    (section.querySelector("h2")?.textContent||"").trim()===title
  )||null;
}

function renderSection(rows){
  const section=document.createElement("section");
  section.className="detail-section property-reference-points-section";
  section.innerHTML=`
    <div class="section-title-row">
      <div><h2>Pontos de referência</h2></div>
    </div>
    <div class="university-list">
      ${rows.map(item=>{
        const distance=formatDistanceMeters(item.distance_m);
        const mapsUrl=String(item.reference_point_maps_url||"").trim();
        return `
          <div class="university-row">
            <div>
              <strong>${esc(item.reference_point_name||"Ponto de referência")}</strong>
              ${distance?`<div class="university-distance">📍 Aproximadamente ${esc(distance)} do imóvel</div>`:""}
            </div>
            ${mapsUrl?`
              <div class="route-modes">
                <a class="btn ghost compact" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Ver no mapa</a>
              </div>
            `:""}
          </div>
        `;
      }).join("")}
    </div>
  `;
  return section;
}

function inject(){
  if(!rowsCache?.length) return false;
  if(document.querySelector(".property-reference-points-section")) return true;

  const root=document.querySelector("#detailRoot");
  if(!root || !root.querySelector(".detail-section")) return false;

  const universities=findSection("Faculdades próximas");
  const config=findSection("Configuração e acesso");
  const anchor=universities||config;
  if(!anchor) return false;

  anchor.insertAdjacentElement("afterend",renderSection(rowsCache));
  return true;
}

async function load(){
  if(!propertyId || loading) return;
  loading=true;
  try{
    const {data,error}=await db.rpc("get_public_property_reference_distances",{p_property_id:propertyId});
    if(error) throw error;
    rowsCache=Array.isArray(data)?data:[];
    if(!rowsCache.length) return;

    if(inject()) return;
    let attempts=0;
    const timer=setInterval(()=>{
      attempts++;
      if(inject()||attempts>=25) clearInterval(timer);
    },160);
  }catch(err){
    console.warn("Pontos de referência indisponíveis:",err);
  }finally{
    loading=false;
  }
}

load();
