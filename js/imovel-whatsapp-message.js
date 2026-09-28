function greetingByDeviceTime(){
  const hour=new Date().getHours();
  if(hour>=5 && hour<12) return "Bom dia";
  if(hour>=12 && hour<18) return "Boa tarde";
  return "Boa noite";
}

function textContent(selector){
  return String(document.querySelector(selector)?.textContent||"").trim();
}

function propertyCode(){
  const badges=[...document.querySelectorAll(".detail-badges .type-chip")]
    .map(el=>String(el.textContent||"").trim());
  const codeBadge=badges.find(text=>/^Código:/i.test(text));
  return codeBadge ? codeBadge.replace(/^Código:\s*/i,"").trim() : "";
}

function whatsappNumberFromHref(href){
  try{
    const url=new URL(href,window.location.href);
    if(!/wa\.me$/i.test(url.hostname) && !/whatsapp\.com$/i.test(url.hostname)) return "";
    return url.pathname.replace(/\D/g,"");
  }catch{
    return "";
  }
}

function buildInterestMessage(){
  const greeting=greetingByDeviceTime();
  const title=textContent(".detail-hero h1") || "Imóvel do catálogo";
  const code=propertyCode();
  const price=textContent(".detail-price strong");
  const region=textContent(".detail-location").replace(/^⌖\s*/,"");
  const pageUrl=window.location.href;

  return [
    `${greeting}! 👋`,
    "",
    "🏠 Vi este imóvel no catálogo e gostaria de saber mais informações.",
    "",
    `📌 Imóvel: ${title}`,
    code ? `🔑 Código: ${code}` : "",
    price ? `💰 Aluguel: ${price}` : "",
    region ? `📍 Região: ${region}` : "",
    "",
    "Tenho interesse em saber se ele ainda está disponível e, se possível, gostaria de agendar uma visita. 😊",
    "",
    "🔗 Anúncio:",
    pageUrl
  ].filter((line,index,array)=>line!=="" || (index>0 && array[index-1]!=="")).join("\n");
}

function enhanceWhatsappLink(anchor){
  if(!anchor || anchor.dataset.prettyWhatsappMessage==="1") return;
  anchor.dataset.prettyWhatsappMessage="1";
  anchor.addEventListener("click",()=>{
    const number=whatsappNumberFromHref(anchor.href);
    if(!number) return;
    anchor.href=`https://wa.me/${number}?text=${encodeURIComponent(buildInterestMessage())}`;
  },true);
}

function scan(){
  document.querySelectorAll('a.btn.whatsapp.full[href*="wa.me"]').forEach(enhanceWhatsappLink);
}

scan();
new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
