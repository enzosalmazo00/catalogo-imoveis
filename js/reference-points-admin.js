import { adminDb as db } from "./config.js?v=202609282145";

const $ = selector => document.querySelector(selector);

function esc(value=""){
  return String(value).replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function withTimeout(promise,ms=12000,label="Operação"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" demorou mais que o esperado.")),ms);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

async function loadPoints(){
  const {data,error}=await db.from("reference_points")
    .select("*")
    .order("sort_order")
    .order("name");
  if(error) throw error;
  return data||[];
}

function setActiveNav(){
  document.querySelectorAll("#adminNav .nav-btn").forEach(btn=>btn.classList.remove("active"));
  $("#adminReferencePointsNav")?.classList.add("active");
  const title=$("#adminTitle");
  if(title) title.textContent="Pontos de referência";
}

async function renderReferencePoints(){
  setActiveNav();
  const content=$("#adminContent");
  if(!content) return;

  content.innerHTML='<section class="admin-panel"><div class="loading-card">Carregando pontos de referência...</div></section>';

  try{
    const rows=await loadPoints();
    content.innerHTML=`
      <section class="admin-panel">
        <div class="admin-panel-head">
          <div>
            <p class="eyebrow">REFERÊNCIAS OPCIONAIS</p>
            <h2>Pontos de referência</h2>
            <p class="muted">Cadastre locais como Banco do Brasil, supermercados, hospitais ou outros pontos conhecidos. O assessor poderá selecionar um ou vários ao anunciar um imóvel.</p>
          </div>
          <button class="btn primary" type="button" data-ref-action="new">+ Novo ponto</button>
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Nome</th><th>Endereço interno</th><th>Ativo</th><th>Ordem</th><th>Ações</th></tr></thead>
            <tbody>
              ${rows.length?rows.map(row=>`
                <tr>
                  <td><strong>${esc(row.name)}</strong></td>
                  <td>${esc(row.address||"—")}</td>
                  <td>${row.active?"Sim":"Não"}</td>
                  <td>${Number(row.sort_order||0)}</td>
                  <td>
                    <div class="table-actions">
                      <button class="btn ghost compact" type="button" data-ref-action="edit" data-ref-id="${row.id}">Editar</button>
                      <button class="btn danger compact" type="button" data-ref-action="delete" data-ref-id="${row.id}">Excluir</button>
                    </div>
                  </td>
                </tr>
              `).join(""):'<tr><td colspan="5" class="muted">Nenhum ponto de referência cadastrado ainda.</td></tr>'}
            </tbody>
          </table>
        </div>

        <p class="tiny-note">No catálogo público aparece apenas o nome do ponto e a distância aproximada até o imóvel. O endereço cadastrado aqui não é exibido nessa lista.</p>
      </section>
    `;
  }catch(err){
    content.innerHTML=`<div class="error-card">Não foi possível carregar os pontos de referência: ${esc(err?.message||"erro desconhecido")}</div>`;
  }
}

function openModal(row=null){
  const layer=$("#adminModal");
  if(!layer) return;

  layer.innerHTML=`
    <div class="modal-card">
      <div class="modal-head">
        <div>
          <p class="eyebrow">PONTO DE REFERÊNCIA</p>
          <h2>${row?"Editar":"Cadastrar"} ponto</h2>
        </div>
        <button class="icon-btn" type="button" data-ref-action="close">✕</button>
      </div>

      <form id="referencePointForm" class="form-grid">
        <input type="hidden" name="id" value="${row?.id||""}">
        <label>Nome
          <input name="name" required value="${esc(row?.name||"")}" placeholder="Ex.: Banco do Brasil">
        </label>
        <label>Ativo?
          <select name="active">
            <option value="true" ${row?.active!==false?"selected":""}>Sim</option>
            <option value="false" ${row?.active===false?"selected":""}>Não</option>
          </select>
        </label>
        <label>Ordem de exibição
          <input name="sort_order" type="number" step="1" min="0" value="${Number(row?.sort_order||0)}">
        </label>
        <label class="span-2">Endereço interno
          <input name="address" value="${esc(row?.address||"")}" placeholder="Opcional; serve apenas para organização do administrador">
        </label>
        <label class="span-2">Link exato no Google Maps
          <input name="google_maps_url" type="url" required value="${esc(row?.google_maps_url||"")}" placeholder="Google Maps → Compartilhar → Copiar link">
          <small>Use o pino/ficha exata do local. O sistema usa esse ponto para calcular a distância até o imóvel.</small>
        </label>
        ${row?.latitude!=null&&row?.longitude!=null?`<div class="span-2 tiny-note">Localização registrada: ${row.latitude}, ${row.longitude}</div>`:""}
        <div id="referencePointMessage" class="form-message span-2" aria-live="polite"></div>
        <div class="form-actions">
          <button class="btn ghost" type="button" data-ref-action="close">Cancelar</button>
          <button class="btn primary" type="submit">Salvar</button>
        </div>
      </form>
    </div>
  `;
  layer.classList.remove("hidden");
}

function closeModal(){
  const layer=$("#adminModal");
  if(!layer) return;
  layer.classList.add("hidden");
  layer.innerHTML="";
}

async function savePoint(form){
  if(!form.checkValidity()){
    form.querySelector(":invalid")?.reportValidity();
    return;
  }

  const msg=$("#referencePointMessage");
  const fd=new FormData(form);
  const id=String(fd.get("id")||"").trim()||null;
  const mapsUrl=String(fd.get("google_maps_url")||"").trim();

  if(msg) msg.textContent="Lendo a localização no Google Maps...";

  try{
    const resolved=await withTimeout(
      db.functions.invoke("resolve-maps-link",{body:{url:mapsUrl}}),
      15000,
      "Leitura do Google Maps"
    );

    if(resolved.error || resolved.data?.error){
      throw new Error(resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.");
    }
    if(resolved.data?.latitude==null || resolved.data?.longitude==null){
      throw new Error("O link não retornou coordenadas. Abra a ficha exata do local no Google Maps e copie o link novamente.");
    }

    const row={
      name:String(fd.get("name")||"").trim(),
      address:String(fd.get("address")||"").trim()||null,
      google_maps_url:mapsUrl,
      latitude:Number(resolved.data.latitude),
      longitude:Number(resolved.data.longitude),
      active:fd.get("active")==="true",
      sort_order:Number(fd.get("sort_order")||0),
      updated_at:new Date().toISOString()
    };

    const result=id
      ? await db.from("reference_points").update(row).eq("id",id)
      : await db.from("reference_points").insert(row);

    if(result.error) throw result.error;

    if(msg) msg.textContent="Ponto de referência salvo com sucesso ✓";
    setTimeout(async()=>{
      closeModal();
      await renderReferencePoints();
    },250);
  }catch(err){
    if(msg) msg.textContent=err?.message||"Não foi possível salvar o ponto de referência.";
  }
}

async function deletePoint(id){
  if(!confirm("Excluir este ponto de referência? Ele também será removido das marcações dos imóveis.")) return;
  const {error}=await db.from("reference_points").delete().eq("id",id);
  if(error){
    alert(error.message);
    return;
  }
  await renderReferencePoints();
}

function installNav(){
  const nav=$("#adminNav");
  if(!nav || $("#adminReferencePointsNav")) return;

  const btn=document.createElement("button");
  btn.id="adminReferencePointsNav";
  btn.className="nav-btn";
  btn.type="button";
  btn.textContent="Pontos de referência";
  btn.dataset.referencePointsTab="true";

  const settings=nav.querySelector('[data-tab="settings"]');
  if(settings) nav.insertBefore(btn,settings);
  else nav.appendChild(btn);

  btn.addEventListener("click",renderReferencePoints);
}

document.addEventListener("click",async event=>{
  const button=event.target.closest("[data-ref-action]");
  if(!button) return;

  const action=button.dataset.refAction;
  if(action==="close"){ closeModal(); return; }
  if(action==="new"){ openModal(); return; }

  if(action==="edit"){
    try{
      const rows=await loadPoints();
      openModal(rows.find(row=>row.id===button.dataset.refId)||null);
    }catch(err){ alert(err?.message||"Não foi possível abrir o ponto."); }
    return;
  }

  if(action==="delete"){
    await deletePoint(button.dataset.refId);
  }
});

document.addEventListener("submit",event=>{
  if(event.target.id!=="referencePointForm") return;
  event.preventDefault();
  event.stopPropagation();
  savePoint(event.target);
},true);

installNav();
setTimeout(installNav,500);
