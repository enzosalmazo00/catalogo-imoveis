import { db, publicImageUrl } from "./config.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHTML(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

export function money(value, currency = "BRL") {
  const number = Number(value || 0);
  const code = currency || "BRL";
  const locale = code === "PYG" ? "es-PY" : "pt-BR";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    maximumFractionDigits: code === "PYG" ? 0 : 2
  }).format(number);
}

export function propertyTypeLabel(type) {
  return ({
    apartamento: "Apartamento",
    casa: "Casa",
    monoambiente: "Monoambiente",
    kitnet: "Kitnet",
    outro: "Outro"
  })[type] || "Imóvel";
}

export function statusLabel(status) {
  return ({
    available: "Disponível",
    rented: "Alugado",
    hidden: "Oculto"
  })[status] || status;
}

export function coverUrl(media = []) {
  const image = [...media]
    .filter(item => item.media_type === "image")
    .sort((a, b) =>
      Number(b.is_cover) - Number(a.is_cover) ||
      (a.sort_order || 0) - (b.sort_order || 0)
    )[0];
  return image ? publicImageUrl(image.storage_path) : "";
}

export function allImageUrls(media = []) {
  return [...media]
    .filter(item => item.media_type === "image")
    .sort((a, b) =>
      Number(b.is_cover) - Number(a.is_cover) ||
      (a.sort_order || 0) - (b.sort_order || 0)
    )
    .map(item => ({ ...item, url: publicImageUrl(item.storage_path) }));
}

export function youtubeEmbed(url = "") {
  const raw = String(url);
  const match = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
  return match ? `https://www.youtube.com/embed/${match[1]}` : "";
}

export async function getSettings() {
  const { data } = await db.from("site_settings").select("*").eq("id", true).maybeSingle();
  return data || {
    site_name: "Catálogo de Imóveis",
    hero_title: "Encontre seu próximo imóvel",
    hero_subtitle: "Imóveis selecionados para locação",
    whatsapp_number: ""
  };
}

export function whatsappLink(settings, property) {
  const number = String(property?.contact_whatsapp || settings?.whatsapp_number || "").replace(/\D/g, "");
  if (!number) return "#";

  const code = property?.public_code || property?.listing_code || "Não informado";
  const advisor = property?.advisor_name || "Assessoria de Imóveis PJC/Ponta Porã";
  const company = property?.advisor_company || "";
  const location = [property?.neighborhood, property?.city].filter(Boolean).join(" • ") || "Localização sob consulta";
  const link = property?.id ? `${locationOriginSafe()}/imovel.html?id=${encodeURIComponent(property.id)}` : "";

  const lines = [
    "Olá! Vi este imóvel no Catálogo de Imóveis e tenho interesse em marcar uma visita.",
    "",
    `Código do imóvel: ${code}`,
    `Imóvel: ${property?.title || "Não informado"}`,
    `Assessor responsável: ${advisor}`,
    company ? `Assessoria / empresa: ${company}` : "",
    `Localização: ${location}`,
    link ? `Anúncio: ${link}` : ""
  ].filter(Boolean);

  return `https://wa.me/${number}?text=${encodeURIComponent(lines.join("\n"))}`;
}

function locationOriginSafe(){
  try{
    return window.location.origin;
  }catch{
    return "";
  }
}

export function locationText(property) {
  return [property.neighborhood, property.city].filter(Boolean).join(" • ")
    || property.address
    || "Localização sob consulta";
}

export function routeText(meters, seconds) {
  if (meters == null || seconds == null) return "";
  const km = (Number(meters) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const mins = Math.max(1, Math.round(Number(seconds) / 60));
  return `${km} km • ${mins} min`;
}

export async function isAdmin() {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return { user: null, admin: false };
  const { data } = await db
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  return { user, admin: !!data };
}

export function slugify(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function mapsQuery(property) {
  if (property.latitude != null && property.longitude != null && property.show_exact_location) {
    return `${property.latitude},${property.longitude}`;
  }
  return [property.neighborhood, property.city].filter(Boolean).join(", ")
    || property.address
    || "";
}
