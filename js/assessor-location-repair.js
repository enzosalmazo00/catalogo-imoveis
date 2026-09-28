import { advisorDb as db } from "./config.js?v=202609282145";

async function repairMissingPropertyCoordinates(){
  try{
    const { data: { user } } = await db.auth.getUser();
    if(!user) return;

    const { data: rows, error } = await db
      .from("properties")
      .select("id,google_maps_url,latitude,longitude")
      .eq("advisor_id", user.id)
      .not("google_maps_url", "is", null);

    if(error || !rows?.length) return;

    const pending = rows.filter(row =>
      row.google_maps_url && (row.latitude == null || row.longitude == null)
    );

    for(const row of pending){
      try{
        const resolved = await db.functions.invoke("resolve-maps-link", {
          body: { url: row.google_maps_url }
        });

        const latitude = resolved.data?.latitude;
        const longitude = resolved.data?.longitude;
        if(latitude == null || longitude == null) continue;

        const { error: updateError } = await db
          .from("properties")
          .update({
            latitude: Number(latitude),
            longitude: Number(longitude)
          })
          .eq("id", row.id)
          .eq("advisor_id", user.id);

        if(updateError) console.warn("Não foi possível atualizar a localização do imóvel:", updateError);
      }catch(err){
        console.warn("Não foi possível reparar a localização deste imóvel:", err);
      }
    }
  }catch(err){
    console.warn("Reparo automático de localização indisponível:", err);
  }
}

function greetingByDeviceTime(){
  const hour=new Date().getHours();
  if(hour>=5 && hour<12) return "Bom dia";
  if(hour>=12 && hour<18) return "Boa tarde";
  return "Boa noite";
}

function advisorCatalogUrl(){
  const openLink=document.querySelector("#openAdvisorCatalog");
  if(openLink?.href && /[?&]catalogo=/.test(openLink.href)) return openLink.href;

  const preview=String(document.querySelector("#advisorCatalogLinkPreview")?.textContent||"").trim();
  if(/^https?:\/\//i.test(preview) && /[?&]catalogo=/.test(preview)) return preview;

  return "";
}

function buildCatalogShareMessage(url){
  const greeting=greetingByDeviceTime();
  const advisorName=String(document.querySelector("#advisorWelcome")?.textContent||"").trim();

  return [
    `${greeting}! 👋`,
    "",
    "🏠 Acompanhe nosso catálogo de imóveis disponíveis.",
    "",
    "Aqui você pode conferir imóveis para locação, ver fotos, valores, características e opções próximas às suas áreas de interesse, incluindo faculdades.",
    "",
    "✨ O catálogo é atualizado conforme os imóveis ficam disponíveis.",
    advisorName ? `🤝 Atendimento: ${advisorName}` : "",
    "",
    "🔗 Acesse o catálogo:",
    url,
    "",
    "Se algum imóvel chamar sua atenção, abra o anúncio e toque em “Tenho interesse” para pedir mais informações ou agendar uma visita. 😊"
  ].filter((line,index,array)=>line!=="" || (index>0 && array[index-1]!=="")).join("\n");
}

function shareCatalogWithPrettyMessage(event){
  const button=event.target.closest("#shareAdvisorCatalog, #shareAdvisorCatalogMain");
  if(!button) return;

  const url=advisorCatalogUrl();
  if(!url) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const text=buildCatalogShareMessage(url);
  const title="Catálogo de imóveis disponíveis";

  if(navigator.share){
    navigator.share({title,text}).catch(err=>{
      if(err?.name!=="AbortError") console.warn("Compartilhamento indisponível:",err);
    });
    return;
  }

  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`,"_blank","noopener");
}

document.addEventListener("click",shareCatalogWithPrettyMessage,true);
repairMissingPropertyCoordinates();
