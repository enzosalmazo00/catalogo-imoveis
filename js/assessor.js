import { db, STORAGE_BUCKET } from "./config.js";
import { $, escapeHTML, money, propertyTypeLabel, statusLabel } from "./common.js?v=202609281430";

let currentUser=null;
let profile=null;
let plans=[];
let subscriptions=[];
let properties=[];
let features=[];
let renewalOffers={};
let countdownTimer=null;
let paymentWatcher=null;
let pendingPropertyFiles=[];
let pendingPropertyCoverExplicit=false;

function withTimeout(promise,ms=8000,label="requisição"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" demorou mais que o esperado.")),ms);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

function fmtDate(v){
  if(!v) return "—";
  return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(new Date(v));
}
function activeSubscription(){
  return subscriptions.find(s=>s.status==="active" && s.ends_at && new Date(s.ends_at)>new Date()) || null;
}
function availableSubscription(){
  return subscriptions.find(s=>{
    if(s.status!=="active" || !s.ends_at || new Date(s.ends_at)<=new Date()) return false;
    const limit=Number(s.advertising_plans?.ad_limit||0);
    return limit>0 && adCountFor(s.id)<limit;
  }) || null;
}
function canCreateAdvisorProperty(){
  return !!availableSubscription();
}
function latestRenewable(){
  return [...subscriptions]
    .filter(s=>s.status==="expired" || (s.ends_at && new Date(s.ends_at)<=new Date()))
    .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0] || null;
}
function adCountFor(subId){
  const sub=subscriptions.find(s=>s.id===subId);
  return Number(sub?.ads_used||0);
}
function closeAdvisorModal(){
  if(paymentWatcher){
    clearInterval(paymentWatcher);
    paymentWatcher=null;
  }
  $("#advisorModal").classList.add("hidden");
  $("#advisorModal").innerHTML="";
}
function showAdvisorModal(html){
  $("#advisorModal").innerHTML='<div class="modal-card">'+html+'</div>';
  $("#advisorModal").classList.remove("hidden");
}

function showAdvisorPropertyPage(html){
  const page=$("#advisorPropertyPage");
  if(!page) return;
  $("#advisorPanel")?.classList.add("hidden");
  page.innerHTML='<div class="advisor-property-page-card">'+html+'</div>';
  page.classList.remove("hidden");
  window.scrollTo({top:0,behavior:"auto"});
}

function closeAdvisorPropertyPage(){
  const page=$("#advisorPropertyPage");
  if(page){
    page.classList.add("hidden");
    page.innerHTML="";
  }
  $("#advisorPanel")?.classList.remove("hidden");
  pendingPropertyFiles=[];
  pendingPropertyCoverExplicit=false;
  window.scrollTo({top:0,behavior:"auto"});
}

async function ensureProfile(user){
  const meta=user.user_metadata||{};
  const fallback={
    user_id:user.id,
    full_name:meta.full_name||user.email?.split("@")[0]||"Assessor",
    whatsapp:String(meta.whatsapp||"").replace(/\D/g,"")||null,
    phone:String(meta.phone||"").replace(/\D/g,"")||null,
    company_name:meta.company_name||null,
    city:meta.city||null,
    service_cities:["Pedro Juan Caballero","Ponta Porã"].includes(meta.city)?[meta.city]:[],
    avatar_path:null
  };

  // O banco agora cria o perfil automaticamente no cadastro.
  // O fallback evita deixar a tela travada se uma consulta estiver lenta.
  profile=fallback;

  try{
    const {data,error}=await withTimeout(
      db.from("advisor_profiles").select("*").eq("user_id",user.id).maybeSingle(),
      7000,
      "Carregamento do perfil"
    );
    if(!error && data) profile=data;
  }catch(err){
    console.warn("Perfil carregado pelos dados da sessão:",err);
  }
}

async function loadData(){
  const results=await Promise.allSettled([
    withTimeout(
      db.from("advertising_plans").select("*").eq("active",true).order("sort_order"),
      8000,
      "Carregamento dos planos"
    ),
    withTimeout(
      db.from("advisor_subscriptions")
        .select("*, advertising_plans(*)")
        .eq("advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento das assinaturas"
    ),
    withTimeout(
      db.from("properties")
        .select("*, property_media(*), property_features(feature_id)")
        .eq("advisor_id",currentUser.id)
        .order("created_at",{ascending:false}),
      8000,
      "Carregamento dos anúncios"
    ),
    withTimeout(
      db.from("features")
        .select("*")
        .eq("active",true)
        .order("category")
        .order("sort_order"),
      8000,
      "Carregamento das opções do imóvel"
    )
  ]);

  const [plRes,subRes,adsRes,featuresRes]=results;
  plans=plRes.status==="fulfilled"?(plRes.value.data||[]):[];
  subscriptions=subRes.status==="fulfilled"?(subRes.value.data||[]):[];
  properties=adsRes.status==="fulfilled"?(adsRes.value.data||[]):[];
  features=featuresRes.status==="fulfilled"?(featuresRes.value.data||[]):[];

  const failures=results.filter(r=>r.status==="rejected");
  if(failures.length){
    console.warn("Alguns dados do painel demoraram para carregar:",failures);
  }

  renewalOffers={};
  const renewable=latestRenewable();
  if(renewable){
    try{
      const {data}=await withTimeout(
        db.rpc("get_or_create_renewal_offer",{p_subscription_id:renewable.id}),
        8000,
        "Carregamento da renovação"
      );
      const offer=Array.isArray(data)?data[0]:data;
      if(offer) renewalOffers[renewable.id]=offer;
    }catch(err){
      console.warn("Oferta de renovação não carregada:",err);
    }
  }

  return failures.length===0;
}

function remainingText(expiresAt){
  const ms=new Date(expiresAt)-new Date();
  if(ms<=0) return "00:00";
  const total=Math.floor(ms/1000);
  const min=String(Math.floor(total/60)).padStart(2,"0");
  const sec=String(total%60).padStart(2,"0");
  return `${min}:${sec}`;
}

function startOfferCountdown(){
  if(countdownTimer) clearInterval(countdownTimer);
  countdownTimer=setInterval(()=>{
    document.querySelectorAll("[data-offer-expires]").forEach(el=>{
      const expires=el.dataset.offerExpires;
      const ms=new Date(expires)-new Date();
      el.textContent=remainingText(expires);
      if(ms<=0){
        clearInterval(countdownTimer);
        renderPlans();
      }
    });
  },1000);
}

function renderPlans(){
  const active=activeSubscription();
  const renewable=latestRenewable();
  $("#advisorPlans").innerHTML=plans.map(plan=>{
    const isActive=active?.plan_id===plan.id;
    const canRenew=renewable?.plan_id===plan.id;
    const offer=canRenew?renewalOffers[renewable.id]:null;
    const offerActive=!!offer && offer.is_active && new Date(offer.expires_at)>new Date();
    const promoPrice=offerActive?Number(offer.promotional_price):Number(plan.price);
    return `
      <article class="advisor-plan-card ${isActive?"active":""}">
        <span class="advisor-plan-badge">${plan.ad_limit} anúncio${plan.ad_limit>1?"s":""}</span>
        <h3>${escapeHTML(plan.name)}</h3>
        <div class="advisor-plan-price">${money(plan.price,"BRL")}</div>
        <p>Validade de ${plan.validity_days} dias.</p>
        ${isActive?`<div class="plan-active-note">Ativo até ${fmtDate(active.ends_at)} • ${adCountFor(active.id)}/${plan.ad_limit} usados</div>`:""}
        ${canRenew && offerActive?`
          <div class="renew-price">
            <span>Oferta de renovação por mais 30 dias</span>
            <div><del>${money(offer.regular_price,"BRL")}</del><strong>${money(promoPrice,"BRL")}</strong></div>
            <small>Oferta válida por <b class="offer-countdown" data-offer-expires="${offer.expires_at}">${remainingText(offer.expires_at)}</b></small>
          </div>
          <button class="btn whatsapp full" data-buy="${plan.id}" data-renew="${renewable.id}" data-offer="${offer.offer_id}">Renovar pelo valor promocional</button>
        `:canRenew?`
          <div class="renew-price expired-offer">
            <span>Oferta promocional encerrada</span>
            <div><strong>${money(plan.price,"BRL")}</strong></div>
          </div>
          <button class="btn primary full" data-buy="${plan.id}" data-renew="${renewable.id}">Renovar por ${money(plan.price,"BRL")}</button>
        `:`
          <button class="btn primary full" data-buy="${plan.id}">Comprar via PIX</button>
        `}
      </article>`;
  }).join("");
  startOfferCountdown();
}
function renderExpiredNotice(){
  const expired=properties.filter(p=>p.listing_expires_at && new Date(p.listing_expires_at)<=new Date());
  const box=$("#advisorExpiredNotice");
  if(!expired.length){box.innerHTML="";return;}
  box.innerHTML=`<div class="advisor-expired-alert"><strong>${expired.length} anúncio${expired.length>1?"s foram":" foi"} retirado${expired.length>1?"s":""} do ar.</strong><span>O período de 30 dias expirou. Renove o pacote abaixo para republicar seus anúncios.</span></div>`;
}

function renderAds(){
  if(!properties.length){
    $("#advisorAds").innerHTML='<div class="empty-state"><strong>Nenhum anúncio publicado ainda.</strong><span>Use uma vaga disponível do seu pacote para publicar seu primeiro imóvel.</span></div>';
    return;
  }
  $("#advisorAds").innerHTML=`
    <div class="advisor-ad-list">
      ${properties.map(p=>{
        const expired=p.listing_expires_at && new Date(p.listing_expires_at)<=new Date();
        return `
          <div class="advisor-ad-row">
            <div>
              <strong>${escapeHTML(p.title)}</strong>
              <span>${escapeHTML([p.neighborhood,p.city].filter(Boolean).join(" • "))}</span>
              <small>${expired?"Expirado":statusLabel(p.status)} • publicado em: ${fmtDate(p.listing_started_at||p.created_at)} • válido até: ${fmtDate(p.listing_expires_at)}</small>
              <small class="listing-code">Código do imóvel: ${escapeHTML(p.public_code||"—")}</small>
            </div>
            <div class="advisor-ad-actions">
              <span class="pill ${expired?"pending":"paid"}">${expired?"FORA DO AR":"PUBLICADO"}</span>
              <button class="btn ghost compact" data-edit-ad="${p.id}">Editar</button>
              <button class="btn danger compact" data-delete-ad="${p.id}">Excluir</button>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

function advisorAvatarUrl(path){
  if(!path) return "";
  return db.storage.from("advisor-avatars").getPublicUrl(path).data.publicUrl || "";
}

function advisorInitials(){
  const name=String(profile?.company_name || profile?.full_name || "Assessor").trim();
  return name.split(/\s+/).slice(0,2).map(p=>p[0]||"").join("").toUpperCase() || "A";
}

function renderAdvisorAvatar(){
  const el=$("#advisorAvatar");
  if(!el) return;

  const url=advisorAvatarUrl(profile?.avatar_path);

  if(!url){
    el.textContent="";
    el.style.backgroundImage="";
    el.classList.remove("has-photo");
    el.classList.add("hidden");
    return;
  }

  el.textContent="";
  el.style.backgroundImage=`url("${url.replace(/"/g,"%22")}")`;
  el.classList.add("has-photo");
  el.classList.remove("hidden");
}

function renderPanel(){
  $("#advisorWelcome").textContent=profile?.company_name || profile?.full_name || "Meus anúncios";
  renderAdvisorAvatar();
  renderExpiredNotice();
  renderPlans();
  renderAds();

  const newBtn=$("#newAdvisorProperty");
  if(newBtn){
    const available=availableSubscription();
    if(available){
      newBtn.disabled=false;
      newBtn.textContent="+ Novo anúncio";
      newBtn.title="";
    }else{
      const active=activeSubscription();
      newBtn.disabled=true;
      newBtn.textContent=active?"Limite de anúncios utilizado":"Nenhum pacote ativo";
      newBtn.title=active
        ?"Seu pacote já está com todas as vagas de anúncio utilizadas."
        :"Compre um pacote para publicar um imóvel.";
    }
  }
}

function advisorProfileModal(){
  const cities=Array.isArray(profile?.service_cities)?profile.service_cities:[];
  const pjcChecked=cities.includes("Pedro Juan Caballero") || (!cities.length && profile?.city==="Pedro Juan Caballero");
  const ppChecked=cities.includes("Ponta Porã") || (!cities.length && profile?.city==="Ponta Porã");

  showAdvisorModal(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">MEU PERFIL</p>
        <h2>Dados do assessor</h2>
        <p class="muted property-form-lead">Atualize seus dados de contato, cidades de atuação e senha.</p>
      </div>
      <button class="icon-btn" data-close>✕</button>
    </div>

    <form id="advisorProfileForm" class="form-grid advisor-profile-form">
      <div class="form-section-title property-section-title">Foto de perfil</div>
      <div class="span-2 advisor-avatar-editor">
        <div id="advisorAvatarPreview" class="advisor-avatar advisor-avatar-large">${profile?.avatar_path ? "" : "👤"}</div>
        <div class="advisor-avatar-upload">
          <label>Escolher foto
            <input name="avatar" type="file" accept="image/jpeg,image/png,image/webp,image/avif">
          </label>
          <small>JPG, PNG, WEBP ou AVIF. Máximo de 5 MB.</small>
        </div>
      </div>

      <div class="form-section-title property-section-title">Dados pessoais e profissionais</div>

      <label>Nome completo
        <input name="full_name" required value="${escapeHTML(profile?.full_name||"")}">
      </label>

      <label>Nome da assessoria / empresa
        <input name="company_name" value="${escapeHTML(profile?.company_name||"")}" placeholder="Ex.: AF Assessoria">
      </label>

      <label>WhatsApp
        <input name="whatsapp" inputmode="tel" required value="${escapeHTML(profile?.whatsapp||"")}" placeholder="Ex.: 595981123456">
      </label>

      <label>Telefone
        <input name="phone" inputmode="tel" value="${escapeHTML(profile?.phone||"")}" placeholder="Ex.: 6734321234">
      </label>

      <label class="span-2">E-mail da conta
        <input value="${escapeHTML(currentUser?.email||"")}" readonly class="readonly-input">
        <small>O e-mail de acesso não é alterado por esta tela.</small>
      </label>

      <div class="form-section-title property-section-title">Cidades onde atua</div>
      <div class="span-2 advisor-city-options">
        <label class="check-chip property-option-chip">
          <input type="checkbox" name="service_cities" value="Pedro Juan Caballero" ${pjcChecked?"checked":""}>
          <span>Pedro Juan Caballero</span>
        </label>
        <label class="check-chip property-option-chip">
          <input type="checkbox" name="service_cities" value="Ponta Porã" ${ppChecked?"checked":""}>
          <span>Ponta Porã</span>
        </label>
      </div>
      <div class="span-2 property-options-help">Você pode marcar as duas cidades.</div>

      <div class="form-section-title property-section-title">Alterar senha</div>
      <div class="span-2 profile-password-note">Deixe os campos abaixo vazios se não quiser alterar a senha.</div>

      <label>Senha atual
        <input name="current_password" type="password" autocomplete="current-password" minlength="6">
      </label>

      <label>Nova senha
        <input name="new_password" type="password" autocomplete="new-password" minlength="6">
      </label>

      <label>Confirmar nova senha
        <input name="confirm_password" type="password" autocomplete="new-password" minlength="6">
      </label>

      <div></div>

      <div class="form-actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit">Salvar perfil</button>
      </div>
      <div id="advisorProfileMessage" class="span-2 form-message"></div>
    </form>
  `);

  const preview=$("#advisorAvatarPreview");
  if(preview){
    const currentUrl=advisorAvatarUrl(profile?.avatar_path);
    if(currentUrl){
      preview.textContent="";
      preview.style.backgroundImage=`url("${currentUrl.replace(/"/g,"%22")}")`;
      preview.classList.add("has-photo");
    }

    form.querySelector('input[name="avatar"]')?.addEventListener("change",e=>{
      const file=e.target.files?.[0];
      if(!file) return;
      if(file.size>5*1024*1024){
        e.target.value="";
        alert("A foto deve ter no máximo 5 MB.");
        return;
      }
      const local=URL.createObjectURL(file);
      preview.textContent="";
      preview.style.backgroundImage=`url("${local}")`;
      preview.classList.add("has-photo");
    });
  }
}

async function saveAdvisorProfile(form){
  const fd=new FormData(form);
  const msg=$("#advisorProfileMessage");

  const fullName=String(fd.get("full_name")||"").trim();
  const companyName=String(fd.get("company_name")||"").trim()||null;
  const whatsapp=String(fd.get("whatsapp")||"").replace(/\D/g,"")||null;
  const phone=String(fd.get("phone")||"").replace(/\D/g,"")||null;
  const cities=[...form.querySelectorAll('input[name="service_cities"]:checked')].map(el=>el.value);

  if(!fullName){
    msg.textContent="Informe seu nome completo.";
    return;
  }
  if(!whatsapp){
    msg.textContent="Informe seu WhatsApp.";
    return;
  }
  if(!cities.length){
    msg.textContent="Selecione pelo menos uma cidade onde você atua.";
    return;
  }

  const currentPassword=String(fd.get("current_password")||"");
  const newPassword=String(fd.get("new_password")||"");
  const confirmPassword=String(fd.get("confirm_password")||"");
  const wantsPasswordChange=currentPassword || newPassword || confirmPassword;

  if(wantsPasswordChange){
    if(!currentPassword || !newPassword || !confirmPassword){
      msg.textContent="Para alterar a senha, preencha senha atual, nova senha e confirmação.";
      return;
    }
    if(newPassword.length<6){
      msg.textContent="A nova senha deve ter pelo menos 6 caracteres.";
      return;
    }
    if(newPassword!==confirmPassword){
      msg.textContent="A confirmação da nova senha não confere.";
      return;
    }
  }

  msg.textContent="Salvando perfil...";

  const avatarFile=form.querySelector('input[name="avatar"]')?.files?.[0] || null;
  let avatarPath=profile?.avatar_path || null;
  let uploadedAvatarPath=null;

  if(avatarFile){
    if(avatarFile.size>5*1024*1024){
      msg.textContent="A foto deve ter no máximo 5 MB.";
      return;
    }

    const ext=(avatarFile.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"") || "jpg";
    uploadedAvatarPath=`${currentUser.id}/avatar-${crypto.randomUUID()}.${ext}`;

    msg.textContent="Enviando foto...";
    const upload=await db.storage.from("advisor-avatars").upload(uploadedAvatarPath,avatarFile,{
      cacheControl:"3600",
      upsert:false
    });

    if(upload.error){
      msg.textContent="Não foi possível enviar a foto: "+upload.error.message;
      return;
    }

    avatarPath=uploadedAvatarPath;
  }

  const profileRow={
    full_name:fullName,
    company_name:companyName,
    whatsapp,
    phone,
    service_cities:cities,
    city:cities.length===1?cities[0]:null,
    avatar_path:avatarPath,
    updated_at:new Date().toISOString()
  };

  const {data:updated,error:profileError}=await db
    .from("advisor_profiles")
    .update(profileRow)
    .eq("user_id",currentUser.id)
    .select("*")
    .single();

  if(profileError){
    if(uploadedAvatarPath) await db.storage.from("advisor-avatars").remove([uploadedAvatarPath]);
    msg.textContent=profileError.message;
    return;
  }

  if(uploadedAvatarPath && profile?.avatar_path && profile.avatar_path!==uploadedAvatarPath){
    await db.storage.from("advisor-avatars").remove([profile.avatar_path]);
  }

  const {error:metaError}=await db.auth.updateUser({
    data:{
      full_name:fullName,
      company_name:companyName||"",
      whatsapp:whatsapp||"",
      phone:phone||"",
      city:cities.length===1?cities[0]:""
    }
  });

  if(metaError){
    msg.textContent="Perfil salvo, mas não foi possível atualizar os dados da sessão: "+metaError.message;
    profile=updated;
    renderPanel();
    return;
  }

  if(wantsPasswordChange){
    msg.textContent="Confirmando sua senha atual...";
    const {error:reauthError}=await db.auth.signInWithPassword({
      email:currentUser.email,
      password:currentPassword
    });

    if(reauthError){
      profile=updated;
      renderPanel();
      msg.textContent="Os dados do perfil foram salvos, mas a senha atual informada está incorreta.";
      return;
    }

    msg.textContent="Alterando senha...";
    const {error:passwordError}=await db.auth.updateUser({password:newPassword});
    if(passwordError){
      profile=updated;
      renderPanel();
      msg.textContent="Os dados do perfil foram salvos, mas não foi possível alterar a senha: "+passwordError.message;
      return;
    }
  }

  profile=updated;
  renderPanel();
  msg.textContent=wantsPasswordChange?"Perfil e senha atualizados com sucesso.":"Perfil atualizado com sucesso.";

  setTimeout(()=>closeAdvisorModal(),900);
}

function countOptions(value,max=10){
  return Array.from({length:max+1},(_,i)=>
    `<option value="${i}" ${Number(value??0)===i?"selected":""}>${i}</option>`
  ).join("");
}

function featureChips(category,selectedIds=[]){
  return features
    .filter(f=>f.category===category)
    .map(f=>`
      <label class="check-chip property-option-chip">
        <input type="checkbox" name="features" value="${f.id}" ${selectedIds.includes(f.id)?"checked":""}>
        <span>${escapeHTML(f.name)}</span>
      </label>`
    ).join("");
}

function propertyMediaPublicUrl(path){
  if(!path) return "";
  return db.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl || "";
}

function sortedPropertyImages(property){
  return [...(property?.property_media||[])]
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));
}

function propertyYoutubeMedia(property){
  return (property?.property_media||[]).find(m=>m.media_type==="youtube") || null;
}

function existingPropertyMediaHtml(property){
  const images=sortedPropertyImages(property);
  const video=propertyYoutubeMedia(property);
  if(!images.length && !video) return "";
  let html='<div class="span-2 current-property-media"><div class="property-options-help">Mídias já publicadas. Foto 1 é a principal exibida no catálogo.</div><div class="property-media-editor-grid">';
  images.forEach((m,index)=>{
    html+='<div class="property-media-editor-item'+(m.is_cover?' cover':'')+'">';
    html+='<div class="property-media-order">Foto '+(index+1)+'</div>';
    html+='<img src="'+escapeHTML(propertyMediaPublicUrl(m.storage_path))+'" alt="">';
    if(m.is_cover) html+='<span class="media-cover-badge">PRINCIPAL</span>';
    html+='<div class="property-media-editor-actions">';
    html+='<button type="button" class="btn ghost compact" data-media-left="'+m.id+'" data-property="'+property.id+'"'+(index===0?' disabled':'')+'>←</button>';
    html+='<button type="button" class="btn ghost compact" data-media-cover="'+m.id+'" data-property="'+property.id+'">Capa</button>';
    html+='<button type="button" class="btn ghost compact" data-media-right="'+m.id+'" data-property="'+property.id+'"'+(index===images.length-1?' disabled':'')+'>→</button>';
    html+='<button type="button" class="btn danger compact" data-media-delete="'+m.id+'" data-property="'+property.id+'">Excluir</button>';
    html+='</div></div>';
  });
  if(video){
    html+='<div class="property-media-editor-item video-media-item"><div class="property-media-order">Vídeo</div><div class="video-media-placeholder">▶</div><div class="property-media-editor-actions one-action"><button type="button" class="btn danger compact" data-video-delete="'+video.id+'" data-property="'+property.id+'">Excluir vídeo</button></div></div>';
  }
  html+='</div></div>';
  return html;
}

function renderPendingPropertyPhotos(){
  const box=$("#pendingPropertyPhotos");
  if(!box) return;
  box.innerHTML="";
  if(!pendingPropertyFiles.length){
    box.innerHTML='<div class="media-empty-note">Nenhuma foto nova selecionada.</div>';
    return;
  }
  pendingPropertyFiles.forEach((file,index)=>{
    const card=document.createElement("div");
    card.className="property-media-editor-item"+(index===0?" cover":"");
    const url=URL.createObjectURL(file);
    card.innerHTML='<div class="property-media-order">Foto '+(index+1)+'</div>'+
      '<img src="'+url+'" alt="Prévia da foto">'+
      (index===0?'<span class="media-cover-badge">'+(pendingPropertyCoverExplicit?"PRINCIPAL":"FOTO 1")+'</span>':'')+
      '<div class="property-media-editor-actions">'+
      '<button type="button" class="btn ghost compact" data-pending-left="'+index+'"'+(index===0?' disabled':'')+'>←</button>'+
      '<button type="button" class="btn ghost compact" data-pending-cover="'+index+'">Capa</button>'+
      '<button type="button" class="btn ghost compact" data-pending-right="'+index+'"'+(index===pendingPropertyFiles.length-1?' disabled':'')+'>→</button>'+
      '<button type="button" class="btn danger compact" data-pending-remove="'+index+'">Excluir</button>'+
      '</div>';
    box.appendChild(card);
  });
}

function existingAdvisorMediaHTML(property){
  const media=[...(property?.property_media||[])].sort((a,b)=>{
    if(a.media_type==="image" && b.media_type==="image"){
      return Number(b.is_cover)-Number(a.is_cover) || Number(a.sort_order||0)-Number(b.sort_order||0);
    }
    if(a.media_type==="image") return -1;
    if(b.media_type==="image") return 1;
    return Number(a.sort_order||0)-Number(b.sort_order||0);
  });

  if(!media.length) return "";

  return `
    <div class="span-2 advisor-media-existing">
      <strong>Mídias já publicadas</strong>
      <div class="advisor-media-grid">
        ${media.map((m,index)=>{
          if(m.media_type==="image"){
            const url=db.storage.from(STORAGE_BUCKET).getPublicUrl(m.storage_path).data.publicUrl;
            return `
              <article class="advisor-media-card">
                <div class="advisor-media-preview">
                  <img src="${escapeHTML(url)}" alt="">
                  <span class="media-order-badge">${m.is_cover?"CAPA":`Foto ${index+1}`}</span>
                </div>
                <div class="advisor-media-card-actions">
                  ${m.is_cover?'<strong>Foto principal ✓</strong>':`<button type="button" class="media-mini-btn" data-advisor-cover="${m.id}" data-property="${property.id}">Definir como capa</button>`}
                  <div class="media-move-row">
                    <button type="button" class="media-mini-btn" data-media-move="-1" data-media-id="${m.id}" data-property="${property.id}" aria-label="Mover foto para antes">←</button>
                    <button type="button" class="media-mini-btn" data-media-move="1" data-media-id="${m.id}" data-property="${property.id}" aria-label="Mover foto para depois">→</button>
                    <button type="button" class="media-mini-btn danger" data-advisor-delete-media="${m.id}" data-property="${property.id}">Excluir</button>
                  </div>
                </div>
              </article>`;
          }
          return `
            <article class="advisor-media-card">
              <div class="advisor-video-placeholder">▶<span>Vídeo</span></div>
              <div class="advisor-media-card-actions">
                <strong>Vídeo do imóvel</strong>
                <button type="button" class="media-mini-btn danger" data-advisor-delete-media="${m.id}" data-property="${property.id}">Excluir vídeo</button>
              </div>
            </article>`;
        }).join("")}
      </div>
      <small>Use as setas para definir a sequência Foto 1, Foto 2, Foto 3... A capa é sempre a imagem principal do catálogo.</small>
    </div>`;
}

function setupNewMediaPreview(){ /* seletor múltiplo removido para compatibilidade com Safari iOS */ }

function propertyDraftKey(property){
  return property?.id ? `edit:${property.id}` : "new";
}

function collectPropertyDraft(form){
  const data={};
  const featureIds=[];

  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el=>{
    if(el.type==="file") return;
    if(el.name==="features"){
      if(el.checked) featureIds.push(el.value);
      return;
    }
    if(el.type==="checkbox"){
      data[el.name]=!!el.checked;
      return;
    }
    data[el.name]=el.value;
  });

  data.features=featureIds;
  return data;
}

function applyPropertyDraft(form,data){
  if(!data || typeof data!=="object") return;

  form.querySelectorAll("input[name],select[name],textarea[name]").forEach(el=>{
    if(el.type==="file" || el.name==="id") return;

    if(el.name==="features"){
      const selected=Array.isArray(data.features)?data.features:[];
      el.checked=selected.includes(el.value);
      return;
    }

    if(!(el.name in data)) return;

    if(el.type==="checkbox"){
      el.checked=!!data[el.name];
    }else{
      el.value=data[el.name]??"";
    }
  });
}

async function loadPropertyDraft(form,property){
  if(!currentUser || !form) return;
  const draftKey=propertyDraftKey(property);
  form.dataset.draftKey=draftKey;

  const status=form.querySelector("#propertyDraftStatus");
  const {data,error}=await db.from("advisor_property_drafts")
    .select("draft_data,updated_at")
    .eq("advisor_id",currentUser.id)
    .eq("draft_key",draftKey)
    .maybeSingle();

  if(error){
    console.warn("Não foi possível consultar o rascunho:",error);
    return;
  }

  if(data?.draft_data){
    applyPropertyDraft(form,data.draft_data);
    wirePropertyTechnicalFields(form);
    if(status){
      status.innerHTML=`<strong>Rascunho recuperado ✓</strong><span>Salvo em ${fmtDate(data.updated_at)}. Fotos precisam ser selecionadas novamente.</span>`;
      status.classList.remove("hidden");
    }
  }
}

async function savePropertyDraft(form){
  if(!currentUser || !form) return;
  const status=form.querySelector("#propertyDraftStatus");
  const draftKey=form.dataset.draftKey || propertyDraftKey(null);

  if(status){
    status.innerHTML="<strong>Salvando rascunho...</strong>";
    status.classList.remove("hidden");
  }

  const {error}=await db.from("advisor_property_drafts").upsert({
    advisor_id:currentUser.id,
    draft_key:draftKey,
    draft_data:collectPropertyDraft(form)
  },{onConflict:"advisor_id,draft_key"});

  if(error){
    if(status) status.innerHTML=`<strong>Não foi possível salvar.</strong><span>${escapeHTML(error.message)}</span>`;
    return;
  }

  if(status){
    status.innerHTML="<strong>Rascunho salvo ✓</strong><span>Você pode sair e continuar depois. As fotos precisam ser escolhidas novamente quando voltar.</span>";
  }
}

async function deletePropertyDraft(form,{silent=false}={}){
  if(!currentUser || !form) return true;
  const draftKey=form.dataset.draftKey || propertyDraftKey(null);
  const status=form.querySelector("#propertyDraftStatus");

  const {error}=await db.from("advisor_property_drafts")
    .delete()
    .eq("advisor_id",currentUser.id)
    .eq("draft_key",draftKey);

  if(error){
    if(!silent && status){
      status.innerHTML=`<strong>Não foi possível excluir o rascunho.</strong><span>${escapeHTML(error.message)}</span>`;
      status.classList.remove("hidden");
    }
    return false;
  }

  if(!silent && status){
    status.innerHTML="<strong>Rascunho excluído.</strong><span>Os campos atuais continuam na tela até você fechar ou publicar.</span>";
    status.classList.remove("hidden");
  }
  return true;
}

function wirePropertyTechnicalFields(form){
  if(!form) return;

  const update=()=>{
    const type=form.querySelector('[name="property_type"]')?.value;
    const housing=form.querySelector('[name="housing_context"]')?.value;
    const garage=form.querySelector('[name="garage_scope"]')?.value;

    form.querySelector("#distributionFields")?.classList.toggle("hidden",type==="monoambiente");
    form.querySelector("#condominiumNameField")?.classList.toggle("hidden",housing!=="condominium");
    form.querySelector("#garageDetails")?.classList.toggle("hidden",garage==="none");
  };

  ["property_type","housing_context","garage_scope"].forEach(name=>{
    form.querySelector(`[name="${name}"]`)?.addEventListener("change",update);
  });
  update();
}

function propertyModal(property=null){
  pendingPropertyFiles=[];
  pendingPropertyCoverExplicit=false;

  const active=property?activeSubscription():availableSubscription();
  if(!property){
    if(!active){
      alert("Você precisa de um pacote ativo para publicar um imóvel.");
      return;
    }
    const plan=active.advertising_plans;
    if(adCountFor(active.id)>=Number(plan.ad_limit)){
      alert("Você já utilizou todos os anúncios disponíveis neste pacote.");
      return;
    }
  }

  const selectedIds=(property?.property_features||[]).map(x=>x.feature_id);
  const furnitureChips=featureChips("furniture",selectedIds);
  const includedChips=featureChips("included",selectedIds);
  const securityChips=featureChips("security",selectedIds);
  const nearbyChips=featureChips("nearby",selectedIds);

  showAdvisorPropertyPage(`
    <div class="modal-head">
      <div>
        <p class="eyebrow">${property?"EDITAR ANÚNCIO":"NOVO ANÚNCIO"}</p>
        <h2>${property?"Editar imóvel":"Cadastrar imóvel"}</h2>
        <p class="muted property-form-lead">Preencha as informações do imóvel. Os campos estão organizados por etapas para facilitar pelo celular.</p>
      </div>
      <button class="icon-btn" data-property-close>✕</button>
    </div>

    <form id="advisorPropertyForm" class="form-grid advisor-property-form">
      <input type="hidden" name="id" value="${property?.id||""}">

      <div class="form-section-title property-section-title">1. Informações principais</div>

      <label class="span-2">Título do anúncio
        <input name="title" required value="${escapeHTML(property?.title||"")}" placeholder="Ex.: Apartamento mobiliado próximo à faculdade">
      </label>

      <label>Tipo de imóvel
        <select name="property_type">
          ${["apartamento","casa","monoambiente","kitnet","outro"].map(t=>`<option value="${t}" ${property?.property_type===t?"selected":""}>${propertyTypeLabel(t)}</option>`).join("")}
        </select>
      </label>

      <label>Status
        <select name="status">
          <option value="available" ${property?.status!=="rented"?"selected":""}>Disponível</option>
          <option value="rented" ${property?.status==="rented"?"selected":""}>Alugado</option>
        </select>
      </label>

      <label>Quartos
        <select name="bedrooms">${countOptions(property?.bedrooms,10)}</select>
      </label>

      <label>Banheiros
        <select name="bathrooms">${countOptions(property?.bathrooms,10)}</select>
      </label>

      <label>O imóvel é mobiliado?
        <select name="furnished">
          <option value="false" ${!property?.furnished?"selected":""}>Não</option>
          <option value="true" ${property?.furnished?"selected":""}>Sim</option>
        </select>
      </label>

      <label>WhatsApp para contato
        <input name="contact_whatsapp" inputmode="tel" required value="${escapeHTML(property?.contact_whatsapp||profile?.whatsapp||"")}" placeholder="Ex.: 595981123456">
      </label>

      <div class="form-section-title property-section-title">2. Valores e condições</div>

      <label>Moeda
        <select name="currency" required>
          <option value="BRL" ${(property?.currency||"BRL")==="BRL"?"selected":""}>Real brasileiro (R$)</option>
          <option value="PYG" ${property?.currency==="PYG"?"selected":""}>Guarani paraguaio (₲)</option>
        </select>
      </label>

      <label>Valor mensal
        <input name="price" type="number" min="0" step="1" required value="${property?.price??""}" placeholder="Ex.: 1500">
      </label>

      <label>Valor da caução
        <input name="security_deposit" type="number" min="0" step="1" value="${property?.security_deposit??""}" placeholder="Ex.: 1500">
      </label>

      <label>Caução pode ser parcelada?
        <select name="security_deposit_installment_allowed">
          <option value="false" ${!property?.security_deposit_installment_allowed?"selected":""}>Não</option>
          <option value="true" ${property?.security_deposit_installment_allowed?"selected":""}>Sim</option>
        </select>
      </label>

      <label>Máximo de parcelas
        <select name="security_deposit_max_installments">
          <option value="">Não informar</option>
          ${Array.from({length:11},(_,i)=>i+2).map(n=>`<option value="${n}" ${Number(property?.security_deposit_max_installments)===n?"selected":""}>${n}x</option>`).join("")}
        </select>
      </label>

      <label>Forma de fechamento
        <select name="closing_mode">
          <option value="advisor" ${property?.closing_mode!=="direct_owner"?"selected":""}>Via assessoria</option>
          <option value="direct_owner" ${property?.closing_mode==="direct_owner"?"selected":""}>Direto com o proprietário</option>
        </select>
      </label>

      <div class="form-section-title property-section-title">3. Tipo, acesso e distribuição</div>

      <label>O imóvel é
        <select name="housing_context" id="housingContext">
          <option value="independent" ${property?.housing_context!=="condominium"?"selected":""}>Independente</option>
          <option value="condominium" ${property?.housing_context==="condominium"?"selected":""}>Em condomínio</option>
        </select>
      </label>

      <label id="condominiumNameField" class="${property?.housing_context==="condominium"?"":"hidden"}">Nome do condomínio
        <input name="condominium_name" value="${escapeHTML(property?.condominium_name||"")}" placeholder="Ex.: Residencial Central">
      </label>

      <label>É imóvel de fundo?
        <select name="is_rear_unit">
          <option value="false" ${!property?.is_rear_unit?"selected":""}>Não</option>
          <option value="true" ${property?.is_rear_unit?"selected":""}>Sim</option>
        </select>
      </label>

      <label>Tem escada para acessar o imóvel?
        <select name="has_stairs_access">
          <option value="false" ${!property?.has_stairs_access?"selected":""}>Não</option>
          <option value="true" ${property?.has_stairs_access?"selected":""}>Sim</option>
        </select>
      </label>

      <div id="distributionFields" class="span-2 conditional-subgrid ${property?.property_type==="monoambiente"?"hidden":""}">
        <label>Quantidade total de cômodos
          <input name="room_count" type="number" min="1" step="1" value="${property?.room_count??""}" placeholder="Ex.: 5">
        </label>

        <label>Sala
          <select name="has_living_room">
            <option value="false" ${!property?.has_living_room?"selected":""}>Não</option>
            <option value="true" ${property?.has_living_room?"selected":""}>Sim</option>
          </select>
        </label>

        <label>Cozinha
          <select name="has_kitchen">
            <option value="false" ${!property?.has_kitchen?"selected":""}>Não</option>
            <option value="true" ${property?.has_kitchen?"selected":""}>Sim</option>
          </select>
        </label>
      </div>

      <label>Lavanderia
        <select name="laundry_type">
          <option value="none" ${(property?.laundry_type||"none")==="none"?"selected":""}>Não possui</option>
          <option value="private" ${property?.laundry_type==="private"?"selected":""}>Privativa</option>
          <option value="shared" ${property?.laundry_type==="shared"?"selected":""}>Compartilhada</option>
        </select>
      </label>

      <label>Garagem
        <select name="garage_scope" id="garageScope">
          <option value="none" ${(property?.garage_scope||"none")==="none"?"selected":""}>Não possui</option>
          <option value="shared" ${property?.garage_scope==="shared"?"selected":""}>Coletiva / compartilhada</option>
          <option value="private" ${property?.garage_scope==="private"?"selected":""}>Própria / privativa</option>
        </select>
      </label>

      <div id="garageDetails" class="span-2 conditional-subgrid ${property?.garage_scope && property.garage_scope!=="none"?"":"hidden"}">
        <label>Garagem para
          <select name="garage_vehicle">
            <option value="car_motorcycle" ${property?.garage_vehicle==="car_motorcycle"?"selected":""}>Carro e moto</option>
            <option value="car" ${property?.garage_vehicle==="car"?"selected":""}>Somente carro</option>
            <option value="motorcycle" ${property?.garage_vehicle==="motorcycle"?"selected":""}>Somente moto</option>
          </select>
        </label>

        <label>Portão eletrônico?
          <select name="has_electronic_gate">
            <option value="false" ${!property?.has_electronic_gate?"selected":""}>Não</option>
            <option value="true" ${property?.has_electronic_gate?"selected":""}>Sim</option>
          </select>
        </label>
      </div>

      <div class="form-section-title property-section-title">4. Mobília e estrutura</div>
      <div class="span-2 property-options-help">Marque tudo que existe no imóvel.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${furnitureChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">5. Segurança</div>
      <div class="span-2 property-options-help">Marque os recursos de segurança disponíveis.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${securityChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">6. Comodidades próximas</div>
      <div class="span-2 property-options-help">Marque o que existe nas proximidades do imóvel.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${nearbyChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">7. O que está incluso no aluguel</div>
      <div class="span-2 property-options-help">Marque somente o que já está incluído no valor mensal.</div>
      <div class="span-2 checkbox-row property-option-grid">
        ${includedChips || '<span class="muted">Nenhuma opção cadastrada.</span>'}
      </div>

      <div class="form-section-title property-section-title">8. Localização</div>

      <label class="span-2 maps-link-field">Link do imóvel no Google Maps
        <input name="google_maps_url" type="url" value="${escapeHTML(property?.google_maps_url||"")}" placeholder="Cole aqui o link compartilhado do Google Maps">
        <small>Abra o local no Google Maps → Compartilhar → Copiar link. Você não precisa informar latitude nem longitude.</small>
      </label>

      <label>Bairro
        <input name="neighborhood" value="${escapeHTML(property?.neighborhood||"")}" placeholder="Ex.: Centro">
      </label>

      <label>Cidade do imóvel
        <select name="city" required>
          <option value="">Selecione a cidade</option>
          <option value="Pedro Juan Caballero" ${(property?.city||profile?.city)==="Pedro Juan Caballero"?"selected":""}>Pedro Juan Caballero</option>
          <option value="Ponta Porã" ${(property?.city||profile?.city)==="Ponta Porã"?"selected":""}>Ponta Porã</option>
        </select>
      </label>

      <label class="span-2">Endereço escrito (opcional)
        <input name="address" value="${escapeHTML(property?.address||"")}" placeholder="Rua, número, bairro">
      </label>

      <label>Exibir localização
        <select name="show_exact_location">
          <option value="false" ${!property?.show_exact_location?"selected":""}>Apenas região aproximada</option>
          <option value="true" ${property?.show_exact_location?"selected":""}>Localização exata</option>
        </select>
      </label>

      <div></div>

      <div class="form-section-title property-section-title">9. Fotos, vídeo e descrição</div>

      <label class="span-2">Descrição do imóvel
        <textarea name="description" placeholder="Descreva o imóvel, condições e diferenciais.">${escapeHTML(property?.description||"")}</textarea>
      </label>

      ${property?existingPropertyMediaHtml(property):""}

      <div class="span-2 property-photo-single-wrap">
        <strong>Adicionar fotos</strong>
        <span class="property-options-help">Adicione uma foto por vez. Cada nova foto entra automaticamente na sequência Foto 1, Foto 2, Foto 3...</span>

        <div class="upload single-property-upload">
          <input id="advisorSinglePhotoInput" type="file" accept="image/jpeg,image/png,image/webp">
          <div class="single-property-upload-copy">
            <strong>📷 Escolher foto da galeria</strong>
            <small>JPG, PNG ou WEBP · uma foto por vez</small>
          </div>
        </div>

        <small>A primeira foto será a principal. Depois você pode reorganizar, trocar a capa ou excluir.</small>
      </div>

      <div id="pendingPropertyPhotos" class="span-2 property-media-editor-grid"></div>

      <label class="span-2">Vídeo do imóvel (YouTube)
        <input name="youtube" type="url" value="${escapeHTML(propertyYoutubeMedia(property)?.external_url||"")}" placeholder="https://youtube.com/watch?v=...">
        <small>Opcional. Cole o link do vídeo do imóvel publicado no YouTube.</small>
      </label>

      ${property?`<div class="span-2 edit-expiry-lock">🔒 A validade permanece em <strong>${fmtDate(property.listing_expires_at)}</strong>. Editar não reinicia os 30 dias.</div>`:""}
      <div id="propertyDraftStatus" class="span-2 property-draft-status hidden"></div>

      <div class="span-2 property-draft-actions">
        <button type="button" class="btn ghost" data-save-property-draft>💾 Salvar rascunho</button>
        <button type="button" class="btn ghost draft-delete-btn" data-delete-property-draft>🗑️ Excluir rascunho</button>
      </div>

      <div class="form-actions">
        <button type="button" class="btn ghost" data-property-close>Cancelar</button>
        <button class="btn primary" type="button" data-publish-property>${property?"Salvar alterações":"Publicar imóvel"}</button>
      </div>
      <div id="advisorPropertyMessage" class="span-2 form-message"></div>
    </form>`);

  const imageInput=$("#advisorSinglePhotoInput");
  imageInput?.addEventListener("change",()=>{
    const file=imageInput.files?.[0]||null;
    if(!file) return;

    if(!["image/jpeg","image/png","image/webp"].includes(file.type)){
      alert("Use uma imagem JPG, PNG ou WEBP.");
      imageInput.value="";
      return;
    }

    pendingPropertyFiles.push(file);
    if(pendingPropertyFiles.length===1 && !(property?.property_media||[]).some(m=>m.media_type==="image")){
      pendingPropertyCoverExplicit=true;
    }

    renderPendingPropertyPhotos();

    // Limpa o input para permitir escolher outra foto usando o mesmo botão.
    imageInput.value="";
  });
  renderPendingPropertyPhotos();
  wirePropertyTechnicalFields($("#advisorPropertyForm"));
  loadPropertyDraft($("#advisorPropertyForm"),property);
}

async function saveProperty(form){
  const fd=new FormData(form);
  const id=fd.get("id")||null;
  const existing=id?properties.find(p=>p.id===id):null;
  const active=existing?null:availableSubscription();
  const msg=$("#advisorPropertyMessage");

  if(!existing && !active){
    msg.textContent="Seu pacote não possui uma vaga disponível para um novo anúncio.";
    return false;
  }

  const title=String(fd.get("title")||"").trim();
  if(!title){
    msg.textContent="Informe o título do anúncio.";
    return false;
  }

  const existingImageCount=(existing?.property_media||[]).filter(m=>m.media_type==="image").length;
  if(!existingImageCount && !pendingPropertyFiles.length){
    msg.textContent="Você precisa adicionar pelo menos uma foto do imóvel.";
    return false;
  }

  const youtubeUrl=String(fd.get("youtube")||"").trim();
  if(youtubeUrl && !/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/.test(youtubeUrl)){
    msg.textContent="Cole um link válido do YouTube ou deixe o campo de vídeo vazio.";
    return false;
  }

  const googleMapsUrl=String(fd.get("google_maps_url")||"").trim()||null;
  let latitude=existing?.latitude??null;
  let longitude=existing?.longitude??null;

  if(googleMapsUrl){
    msg.textContent="1/4 • Validando localização...";
    const resolved=await withTimeout(
      db.functions.invoke("resolve-maps-link",{body:{url:googleMapsUrl}}),
      12000,
      "Leitura do Google Maps"
    );
    if(resolved.error || resolved.data?.error){
      msg.textContent=resolved.data?.error || resolved.error?.message || "Não foi possível ler o link do Google Maps.";
      return false;
    }
    if(resolved.data?.latitude!=null && resolved.data?.longitude!=null){
      latitude=Number(resolved.data.latitude);
      longitude=Number(resolved.data.longitude);
    }
  }

  const row={
    title,
    slug:existing?.slug || title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")+"-"+Date.now().toString(36),
    property_type:fd.get("property_type"),
    description:String(fd.get("description")||"").trim()||null,
    price:Number(fd.get("price")),
    currency:fd.get("currency")||"BRL",
    security_deposit:fd.get("security_deposit")?Number(fd.get("security_deposit")):null,
    security_deposit_installment_allowed:fd.get("security_deposit_installment_allowed")==="true",
    security_deposit_max_installments:fd.get("security_deposit_installment_allowed")==="true" && fd.get("security_deposit_max_installments")?Number(fd.get("security_deposit_max_installments")):null,
    closing_mode:fd.get("closing_mode"),
    contact_whatsapp:String(fd.get("contact_whatsapp")||"").replace(/\D/g,""),
    bedrooms:Number(fd.get("bedrooms")||0),
    bathrooms:Number(fd.get("bathrooms")||0),
    furnished:fd.get("furnished")==="true",
    housing_context:fd.get("housing_context")||"independent",
    condominium_name:fd.get("housing_context")==="condominium" ? String(fd.get("condominium_name")||"").trim()||null : null,
    is_rear_unit:fd.get("is_rear_unit")==="true",
    has_stairs_access:fd.get("has_stairs_access")==="true",
    room_count:fd.get("property_type")==="monoambiente" ? null : (fd.get("room_count")?Number(fd.get("room_count")):null),
    has_living_room:fd.get("property_type")==="monoambiente" ? false : fd.get("has_living_room")==="true",
    has_kitchen:fd.get("property_type")==="monoambiente" ? false : fd.get("has_kitchen")==="true",
    laundry_type:fd.get("laundry_type")||"none",
    garage_scope:fd.get("garage_scope")||"none",
    garage_vehicle:fd.get("garage_scope")==="none" ? "none" : (fd.get("garage_vehicle")||"none"),
    has_electronic_gate:fd.get("garage_scope")==="none" ? false : fd.get("has_electronic_gate")==="true",
    neighborhood:String(fd.get("neighborhood")||"").trim()||null,
    city:String(fd.get("city")||"").trim()||null,
    address:String(fd.get("address")||"").trim()||null,
    google_maps_url:googleMapsUrl,
    latitude,
    longitude,
    show_exact_location:fd.get("show_exact_location")==="true",
    status:fd.get("status")
  };

  const selectedFeatureIds=[...form.querySelectorAll('input[name="features"]:checked')].map(el=>el.value);

  // EDITAR: mantém identidade e prazo do anúncio original.
  if(existing){
    msg.textContent="2/4 • Salvando alterações...";

    const updateRow={...row};

    const upd=await db.from("properties")
      .update(updateRow)
      .eq("id",existing.id)
      .eq("advisor_id",currentUser.id);

    if(upd.error){
      msg.textContent="Não foi possível salvar: "+upd.error.message;
      return false;
    }

    const delFeatures=await db.from("property_features").delete().eq("property_id",existing.id);
    if(delFeatures.error){
      msg.textContent="Não foi possível atualizar as características: "+delFeatures.error.message;
      return false;
    }

    if(selectedFeatureIds.length){
      const featureRows=selectedFeatureIds.map(feature_id=>({property_id:existing.id,feature_id}));
      const featureInsert=await db.from("property_features").insert(featureRows);
      if(featureInsert.error){
        msg.textContent="Não foi possível atualizar as características: "+featureInsert.error.message;
        return false;
      }
    }

    const existingImages=sortedPropertyImages(existing);

    if(pendingPropertyCoverExplicit && existingImages.length){
      await db.from("property_media").update({is_cover:false}).eq("property_id",existing.id).eq("media_type","image");
      for(let i=0;i<existingImages.length;i++){
        await db.from("property_media")
          .update({sort_order:(pendingPropertyFiles.length+i)*10})
          .eq("id",existingImages[i].id);
      }
    }

    msg.textContent="3/4 • Enviando novas fotos...";
    for(let index=0;index<pendingPropertyFiles.length;index++){
      const file=pendingPropertyFiles[index];
      const safe=file.name.replace(/[^A-Za-z0-9._-]/g,"_");
      const path=`${currentUser.id}/${existing.id}/${crypto.randomUUID()}-${safe}`;

      const up=await db.storage.from(STORAGE_BUCKET).upload(path,file,{
        contentType:file.type||undefined,
        cacheControl:"3600",
        upsert:false
      });
      if(up.error){
        msg.textContent="Falha ao enviar foto: "+up.error.message;
        return false;
      }

      const shouldCover=(!existingImages.length && index===0) || (pendingPropertyCoverExplicit && index===0);
      const sortOrder=pendingPropertyCoverExplicit ? index*10 : (existingImages.length+index)*10;
      const mediaInsert=await db.from("property_media").insert({
        property_id:existing.id,
        media_type:"image",
        storage_path:path,
        is_cover:shouldCover,
        sort_order:sortOrder
      });
      if(mediaInsert.error){
        await db.storage.from(STORAGE_BUCKET).remove([path]);
        msg.textContent="Falha ao registrar foto: "+mediaInsert.error.message;
        return false;
      }
    }

    const existingYoutube=propertyYoutubeMedia(existing);
    if(existingYoutube && existingYoutube.external_url!==youtubeUrl){
      const delVideo=await db.from("property_media").delete().eq("id",existingYoutube.id);
      if(delVideo.error){
        msg.textContent="Não foi possível atualizar o vídeo: "+delVideo.error.message;
        return false;
      }
    }
    if(youtubeUrl && (!existingYoutube || existingYoutube.external_url!==youtubeUrl)){
      const videoInsert=await db.from("property_media").insert({
        property_id:existing.id,
        media_type:"youtube",
        external_url:youtubeUrl,
        is_cover:false,
        sort_order:10000
      });
      if(videoInsert.error){
        msg.textContent="Não foi possível registrar o vídeo: "+videoInsert.error.message;
        return false;
      }
    }

    await deletePropertyDraft(form,{silent:true});
    msg.textContent="4/4 • Alterações salvas com sucesso.";
    await loadData();
    renderPanel();
    closeAdvisorPropertyPage();
    return true;
  }

  // NOVA PUBLICAÇÃO: primeiro envia as fotos para um ID reservado.
  // O imóvel só é criado e publicado depois que todas as fotos estiverem prontas.
  const propertyId=crypto.randomUUID();
  const uploadedPaths=[];
  const media=[];

  try{
    msg.textContent="2/4 • Enviando fotos...";
    for(let index=0;index<pendingPropertyFiles.length;index++){
      const file=pendingPropertyFiles[index];
      const safe=file.name.replace(/[^A-Za-z0-9._-]/g,"_");
      const path=`${currentUser.id}/${propertyId}/${crypto.randomUUID()}-${safe}`;

      const up=await db.storage.from(STORAGE_BUCKET).upload(path,file,{
        contentType:file.type||undefined,
        cacheControl:"3600",
        upsert:false
      });
      if(up.error) throw new Error("Falha ao enviar a foto "+(index+1)+": "+up.error.message);

      uploadedPaths.push(path);
      media.push({
        media_type:"image",
        storage_path:path,
        is_cover:index===0,
        sort_order:index*10
      });
    }

    if(youtubeUrl){
      media.push({
        media_type:"youtube",
        external_url:youtubeUrl,
        is_cover:false,
        sort_order:10000
      });
    }

    msg.textContent="3/4 • Registrando e publicando imóvel...";
    const published=await withTimeout(
      db.rpc("publish_advisor_property",{
        p_property_id:propertyId,
        p_subscription_id:active.id,
        p_property:row,
        p_feature_ids:selectedFeatureIds,
        p_media:media
      }),
      15000,
      "Publicação do imóvel"
    );

    if(published.error) throw new Error(published.error.message);

    msg.textContent="4/4 • Imóvel publicado com sucesso.";
    await deletePropertyDraft(form,{silent:true});
    await loadData();
    renderPanel();

    const created=properties.find(p=>p.id===propertyId);
    if(!created){
      throw new Error("O imóvel foi publicado, mas o painel ainda não conseguiu recarregá-lo.");
    }

    closeAdvisorPropertyPage();
    return true;
  }catch(err){
    console.error("Falha na publicação atômica do imóvel:",err);

    if(uploadedPaths.length){
      try{ await db.storage.from(STORAGE_BUCKET).remove(uploadedPaths); }catch{}
    }

    msg.textContent="Não foi possível publicar: "+(err?.message||"erro desconhecido");
    return false;
  }
}

async function setAdvisorCover(mediaId,propertyId){
  const property=properties.find(p=>p.id===propertyId);
  if(!property) return;

  const images=(property.property_media||[])
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0));

  const chosen=images.find(m=>m.id===mediaId);
  if(!chosen) return;

  const {error:clearError}=await db.from("property_media")
    .update({is_cover:false})
    .eq("property_id",propertyId)
    .eq("media_type","image");
  if(clearError) return alert(clearError.message);

  const {error:setError}=await db.from("property_media")
    .update({is_cover:true,sort_order:0})
    .eq("id",mediaId);
  if(setError) return alert(setError.message);

  let order=10;
  for(const image of images.filter(m=>m.id!==mediaId)){
    await db.from("property_media").update({sort_order:order}).eq("id",image.id);
    order+=10;
  }

  await loadData();
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function moveAdvisorMedia(mediaId,propertyId,direction){
  const property=properties.find(p=>p.id===propertyId);
  if(!property) return;

  const images=(property.property_media||[])
    .filter(m=>m.media_type==="image")
    .sort((a,b)=>Number(b.is_cover)-Number(a.is_cover) || Number(a.sort_order||0)-Number(b.sort_order||0));

  const index=images.findIndex(m=>m.id===mediaId);
  const target=index+Number(direction);
  if(index<0 || target<0 || target>=images.length) return;

  const reordered=[...images];
  [reordered[index],reordered[target]]=[reordered[target],reordered[index]];

  // A capa continua sendo capa; as setas alteram apenas a sequência das demais fotos.
  const cover=reordered.find(m=>m.is_cover);
  const rest=reordered.filter(m=>!m.is_cover);
  let order=cover?10:0;
  for(const image of rest){
    await db.from("property_media").update({sort_order:order}).eq("id",image.id);
    order+=10;
  }
  if(cover) await db.from("property_media").update({sort_order:0}).eq("id",cover.id);

  await loadData();
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function deleteAdvisorMedia(mediaId,propertyId){
  const property=properties.find(p=>p.id===propertyId);
  const media=(property?.property_media||[]).find(m=>m.id===mediaId);
  if(!media || !confirm("Excluir esta mídia do anúncio?")) return;

  if(media.media_type==="image" && media.storage_path){
    await db.storage.from(STORAGE_BUCKET).remove([media.storage_path]);
  }
  const {error}=await db.from("property_media").delete().eq("id",mediaId);
  if(error) return alert(error.message);

  await loadData();
  const refreshed=properties.find(p=>p.id===propertyId);
  const images=(refreshed?.property_media||[]).filter(m=>m.media_type==="image");
  if(media.is_cover && images.length){
    const next=[...images].sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0))[0];
    await db.from("property_media").update({is_cover:true,sort_order:0}).eq("id",next.id);
    await loadData();
  }
  propertyModal(properties.find(p=>p.id===propertyId));
}

async function watchPaymentStatus(subscriptionId){
  if(paymentWatcher) clearInterval(paymentWatcher);

  let attempts=0;
  const maxAttempts=90; // ~3 minutos

  const check=async()=>{
    attempts++;

    try{
      const {data,error}=await db.functions.invoke("check-advisor-pix",{
        body:{subscription_id:subscriptionId}
      });

      if(error || data?.error) throw new Error(data?.error || error?.message || "Falha ao verificar pagamento.");

      const statusEl=$("#pixStatus");
      if(data?.status==="active"){
        if(paymentWatcher){
          clearInterval(paymentWatcher);
          paymentWatcher=null;
        }

        if(statusEl){
          statusEl.innerHTML='<strong>Pagamento aprovado ✓</strong><span>Seu pacote foi liberado. Abrindo sua Área do Assessor...</span>';
          statusEl.classList.add("pix-approved");
        }

        await loadData();
        renderPanel();

        setTimeout(()=>{
          closeAdvisorModal();
        },1200);

        return;
      }

      if(data?.status==="cancelled" || data?.status==="expired"){
        if(paymentWatcher){
          clearInterval(paymentWatcher);
          paymentWatcher=null;
        }
        if(statusEl){
          statusEl.innerHTML='<strong>Pagamento não concluído.</strong><span>Feche esta janela e gere um novo PIX.</span>';
        }
        return;
      }

      if(attempts>=maxAttempts){
        clearInterval(paymentWatcher);
        paymentWatcher=null;
        if(statusEl){
          statusEl.innerHTML='<strong>Ainda aguardando confirmação.</strong><span>Se você já pagou, pode fechar esta janela. O pacote será liberado automaticamente assim que o Mercado Pago confirmar.</span>';
        }
      }
    }catch(err){
      console.warn("Falha temporária ao consultar pagamento:",err);
    }
  };

  await check();
  if(!paymentWatcher){
    paymentWatcher=setInterval(check,2000);
  }
}

async function startPayment(planId,renewalOf=null,offerId=null){
  const {data,error}=await db.functions.invoke("create-advisor-pix",{body:{plan_id:planId,renewal_of:renewalOf,renewal_offer_id:offerId}});
  if(error || !data || data.error){
    alert(data?.error || error?.message || "A integração PIX ainda está sendo finalizada.");
    return;
  }
  showAdvisorModal(`
    <div class="modal-head"><div><p class="eyebrow">PAGAMENTO PIX</p><h2>Concluir pagamento</h2></div><button class="icon-btn" data-close>✕</button></div>
    <div class="pix-box">
      <strong>Total: ${money(data.amount,"BRL")}</strong>
      ${data.discount_percent?'<span class="promo-label">Oferta promocional aplicada</span>':""}
      ${data.qr_code_base64?`<img class="pix-qr" src="data:image/png;base64,${data.qr_code_base64}" alt="QR Code PIX">`:""}
      ${data.qr_code?`<textarea id="pixCopy" readonly>${escapeHTML(data.qr_code)}</textarea><button class="btn primary" id="copyPix">Copiar PIX</button>`:""}
      <div id="pixStatus" class="pix-payment-status"><strong>Aguardando confirmação do pagamento...</strong><span>Assim que o Mercado Pago confirmar, esta tela será atualizada automaticamente.</span></div>
    </div>`);
  $("#copyPix")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("#pixCopy").value);$("#copyPix").textContent="PIX copiado ✓";});
  if(data.subscription_id) watchPaymentStatus(data.subscription_id);
}

async function enterAdvisorPanel(user){
  if(!user) throw new Error("Usuário não identificado após o login.");

  currentUser=user;

  // Mostra o painel imediatamente após a autenticação, sem exibir o login no meio.
  $("#advisorBootLoader")?.classList.add("hidden");
  $("#advisorAuth").classList.add("hidden");
  $("#advisorResetPassword").classList.add("hidden");
  $("#advisorPropertyPage")?.classList.add("hidden");
  $("#advisorPanel").classList.remove("hidden");
  $("#advisorWelcome").textContent="Carregando sua área...";

  try{
    await ensureProfile(user);
    const fullyLoaded=await loadData();
    renderPanel();
    if(!fullyLoaded){
      $("#advisorExpiredNotice").innerHTML=
        '<div class="advisor-expired-alert"><strong>Painel aberto.</strong><span>Algumas informações demoraram para carregar. Atualize a página se algum plano ou anúncio não aparecer.</span></div>';
    }
  }catch(err){
    console.error("Erro ao carregar a Área do Assessor:",err);
    $("#advisorWelcome").textContent="Área do Assessor";
    $("#advisorExpiredNotice").innerHTML=
      '<div class="advisor-expired-alert"><strong>Login realizado.</strong><span>Houve um erro ao carregar os dados do painel. Atualize a página para tentar novamente.</span></div>';
  }
}

async function boot(){
  const hashParams=new URLSearchParams(location.hash.replace(/^#/,""));
  const searchParams=new URLSearchParams(location.search);
  const isRecovery=hashParams.get("type")==="recovery" || searchParams.get("type")==="recovery";

  if(isRecovery){
    $("#advisorBootLoader")?.classList.add("hidden");
    $("#advisorAuth").classList.add("hidden");
    $("#advisorPanel").classList.add("hidden");
    $("#advisorPropertyPage")?.classList.add("hidden");
    $("#advisorResetPassword").classList.remove("hidden");
    return;
  }

  const loader=$("#advisorBootLoader");
  const bootTitle=$("#advisorBootTitle");
  const bootText=$("#advisorBootText");
  const bootActions=$("#advisorBootActions");
  const bootSpinner=$("#advisorBootSpinner");

  if(loader) loader.classList.remove("hidden");
  if(bootActions) bootActions.classList.add("hidden");
  if(bootSpinner) bootSpinner.classList.remove("hidden");
  if(bootTitle) bootTitle.textContent="Abrindo sua área...";
  if(bootText) bootText.textContent="Validando sua sessão.";

  try{
    // getUser valida o usuário atual no servidor e evita depender apenas
    // de uma sessão local antiga do navegador.
    const userResult=await withTimeout(
      db.auth.getUser(),
      7000,
      "Validação da sessão"
    );

    const user=userResult?.data?.user||null;
    const authError=userResult?.error||null;

    if(authError || !user){
      currentUser=null;
      loader?.classList.add("hidden");
      $("#advisorAuth").classList.remove("hidden");
      $("#advisorPanel").classList.add("hidden");

      if(authError){
        $("#advisorAuthMessage").textContent="Sua sessão neste navegador expirou. Entre novamente.";
      }
      return;
    }

    currentUser=user;
    await enterAdvisorPanel(user);
  }catch(err){
    console.warn("Falha ao validar sessão neste dispositivo:",err);

    if(bootSpinner) bootSpinner.classList.add("hidden");
    if(bootTitle) bootTitle.textContent="Não conseguimos validar sua sessão neste navegador.";
    if(bootText) bootText.textContent="Tente novamente. Se continuar, entre novamente para criar uma sessão nova neste navegador.";
    if(bootActions) bootActions.classList.remove("hidden");
  }
}

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-auth-tab]");
  if(tab){
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b===tab));
    $("#advisorLoginForm").classList.toggle("hidden",tab.dataset.authTab!=="login");
    $("#advisorSignupForm").classList.toggle("hidden",tab.dataset.authTab!=="signup");
  }
  const propertyClose=e.target.closest("[data-property-close]");
  if(propertyClose){
    closeAdvisorPropertyPage();
    return;
  }

    const publishPropertyBtn=e.target.closest("[data-publish-property]");
  if(publishPropertyBtn){
    e.preventDefault();
    await runPropertySave($("#advisorPropertyForm"));
    return;
  }

    const saveDraftBtn=e.target.closest("[data-save-property-draft]");
  if(saveDraftBtn){
    const form=$("#advisorPropertyForm");
    if(form) await savePropertyDraft(form);
  }

  const deleteDraftBtn=e.target.closest("[data-delete-property-draft]");
  if(deleteDraftBtn){
    const form=$("#advisorPropertyForm");
    if(form && confirm("Excluir o rascunho salvo deste imóvel?")){
      await deletePropertyDraft(form);
    }
  }

  const pendingLeft=e.target.closest("[data-pending-left]");
  if(pendingLeft){
    const i=Number(pendingLeft.dataset.pendingLeft);
    if(i>0){
      [pendingPropertyFiles[i-1],pendingPropertyFiles[i]]=[pendingPropertyFiles[i],pendingPropertyFiles[i-1]];
      renderPendingPropertyPhotos();
    }
  }
  const pendingRight=e.target.closest("[data-pending-right]");
  if(pendingRight){
    const i=Number(pendingRight.dataset.pendingRight);
    if(i<pendingPropertyFiles.length-1){
      [pendingPropertyFiles[i+1],pendingPropertyFiles[i]]=[pendingPropertyFiles[i],pendingPropertyFiles[i+1]];
      renderPendingPropertyPhotos();
    }
  }
  const pendingCover=e.target.closest("[data-pending-cover]");
  if(pendingCover){
    const i=Number(pendingCover.dataset.pendingCover);
    if(i>=0 && i<pendingPropertyFiles.length){
      const selected=pendingPropertyFiles.splice(i,1)[0];
      pendingPropertyFiles.unshift(selected);
      pendingPropertyCoverExplicit=true;
      renderPendingPropertyPhotos();
    }
  }
  const pendingRemove=e.target.closest("[data-pending-remove]");
  if(pendingRemove){
    const i=Number(pendingRemove.dataset.pendingRemove);
    pendingPropertyFiles.splice(i,1);
    renderPendingPropertyPhotos();
  }

  const mediaCover=e.target.closest("[data-media-cover]");
  if(mediaCover){
    const propertyId=mediaCover.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const images=sortedPropertyImages(item);
    const chosen=images.find(m=>m.id===mediaCover.dataset.mediaCover);
    if(chosen){
      const ordered=[chosen,...images.filter(m=>m.id!==chosen.id)];
      await db.from("property_media").update({is_cover:false}).eq("property_id",propertyId).eq("media_type","image");
      for(let i=0;i<ordered.length;i++){
        await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",ordered[i].id);
      }
      await loadData();
      propertyModal(properties.find(p=>p.id===propertyId));
    }
  }

  const mediaDelete=e.target.closest("[data-media-delete]");
  if(mediaDelete && confirm("Excluir esta foto?")){
    const propertyId=mediaDelete.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const media=(item?.property_media||[]).find(m=>m.id===mediaDelete.dataset.mediaDelete);
    if(media?.storage_path) await db.storage.from(STORAGE_BUCKET).remove([media.storage_path]);
    await db.from("property_media").delete().eq("id",mediaDelete.dataset.mediaDelete);
    const {data:remaining}=await db.from("property_media").select("id,is_cover,sort_order").eq("property_id",propertyId).eq("media_type","image").order("sort_order");
    if(remaining?.length){
      for(let i=0;i<remaining.length;i++) await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",remaining[i].id);
    }
    await loadData();
    propertyModal(properties.find(p=>p.id===propertyId));
  }

  const mediaLeft=e.target.closest("[data-media-left]");
  const mediaRight=e.target.closest("[data-media-right]");
  if(mediaLeft || mediaRight){
    const button=mediaLeft||mediaRight;
    const propertyId=button.dataset.property;
    const item=properties.find(p=>p.id===propertyId);
    const images=sortedPropertyImages(item);
    const id=mediaLeft?button.dataset.mediaLeft:button.dataset.mediaRight;
    const index=images.findIndex(m=>m.id===id);
    const target=mediaLeft?index-1:index+1;
    if(index>=0 && target>=0 && target<images.length){
      [images[index],images[target]]=[images[target],images[index]];
      for(let i=0;i<images.length;i++) await db.from("property_media").update({sort_order:i*10,is_cover:i===0}).eq("id",images[i].id);
      await loadData();
      propertyModal(properties.find(p=>p.id===propertyId));
    }
  }

  const videoDelete=e.target.closest("[data-video-delete]");
  if(videoDelete && confirm("Excluir o vídeo deste imóvel?")){
    const propertyId=videoDelete.dataset.property;
    await db.from("property_media").delete().eq("id",videoDelete.dataset.videoDelete);
    await loadData();
    propertyModal(properties.find(p=>p.id===propertyId));
  }
  const buy=e.target.closest("[data-buy]");
  if(buy) await startPayment(buy.dataset.buy,buy.dataset.renew||null,buy.dataset.offer||null);
  if(e.target.closest("#advisorProfileBtn")) advisorProfileModal();
  if(e.target.closest("#newAdvisorProperty")){
    if(!canCreateAdvisorProperty()){
      alert(activeSubscription()
        ?"Você já utilizou todas as vagas de anúncio do seu pacote atual."
        :"Você precisa de um pacote ativo para publicar um imóvel.");
    }else{
      propertyModal();
    }
  }

  const coverBtn=e.target.closest("[data-advisor-cover]");
  if(coverBtn) await setAdvisorCover(coverBtn.dataset.advisorCover,coverBtn.dataset.property);

  const moveBtn=e.target.closest("[data-media-move]");
  if(moveBtn) await moveAdvisorMedia(moveBtn.dataset.mediaId,moveBtn.dataset.property,moveBtn.dataset.mediaMove);

  const deleteMediaBtn=e.target.closest("[data-advisor-delete-media]");
  if(deleteMediaBtn) await deleteAdvisorMedia(deleteMediaBtn.dataset.advisorDeleteMedia,deleteMediaBtn.dataset.property);
  const edit=e.target.closest("[data-edit-ad]");
  if(edit){
    const item=properties.find(p=>p.id===edit.dataset.editAd);
    if(item?.listing_expires_at && new Date(item.listing_expires_at)<=new Date()){
      alert("Este anúncio expirou. Renove o pacote para voltar a editar e publicar o imóvel.");
    }else{
      propertyModal(item);
    }
  }
  if(e.target.closest("[data-close]")) closeAdvisorModal();
  const del=e.target.closest("[data-delete-ad]");
  if(del && confirm("Excluir este anúncio definitivamente?")){
    const p=properties.find(x=>x.id===del.dataset.deleteAd);
    const paths=(p?.property_media||[]).filter(m=>m.storage_path).map(m=>m.storage_path);
    if(paths.length) await db.storage.from(STORAGE_BUCKET).remove(paths);
    await db.from("properties").delete().eq("id",del.dataset.deleteAd);
    await loadData();renderPanel();
  }
});

$("#advisorModal").addEventListener("submit",async e=>{
  e.preventDefault();
  if(e.target.id==="advisorProfileForm") await saveAdvisorProfile(e.target);
});

async function runPropertySave(form){
  if(!form) return;

  const submit=form.querySelector("[data-publish-property]");
  const originalText=submit?.textContent||"";

  if(!form.checkValidity()){
    const invalid=form.querySelector(":invalid");
    const label=invalid?.closest("label");
    const fieldName=(label?.childNodes?.[0]?.textContent||"campo obrigatório").trim();
    const msg=form.querySelector("#advisorPropertyMessage");
    if(msg) msg.textContent="Revise o campo: "+fieldName+".";
    invalid?.scrollIntoView({behavior:"smooth",block:"center"});
    setTimeout(()=>invalid?.reportValidity(),250);
    return;
  }

  if(submit){
    submit.disabled=true;
    submit.textContent=form.querySelector('input[name="id"]')?.value
      ?"Salvando..."
      :"Publicando...";
  }

  try{
    await saveProperty(form);
  }catch(err){
    console.error("Falha inesperada ao salvar imóvel:",err);
    const msg=form.querySelector("#advisorPropertyMessage");
    if(msg) msg.textContent="Não foi possível concluir: "+(err?.message||"erro inesperado");
  }finally{
    if(document.body.contains(form) && submit){
      submit.disabled=false;
      submit.textContent=originalText;
    }
  }
}

$("#advisorPropertyPage")?.addEventListener("submit",e=>{
  // Evita qualquer submit nativo acidental.
  if(e.target.id==="advisorPropertyForm") e.preventDefault();
});

$("#forgotPasswordBtn").addEventListener("click",async()=>{
  const email=$("#advisorLoginEmail").value.trim();
  const msg=$("#advisorAuthMessage");
  if(!email){
    msg.textContent="Digite seu e-mail primeiro para receber o link de recuperação.";
    $("#advisorLoginEmail").focus();
    return;
  }
  msg.textContent="Enviando link de recuperação...";
  const redirectTo=location.origin + location.pathname + "?type=recovery";
  const {error}=await db.auth.resetPasswordForEmail(email,{redirectTo});
  if(error){
    msg.textContent=error.message;
    return;
  }
  msg.textContent="Se esse e-mail estiver cadastrado, enviaremos um link para redefinir sua senha.";
});

$("#advisorResetPasswordForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const password=$("#advisorNewPassword").value;
  const confirm=$("#advisorConfirmPassword").value;
  const msg=$("#advisorResetMessage");

  if(password.length<6){
    msg.textContent="A nova senha deve ter pelo menos 6 caracteres.";
    return;
  }
  if(password!==confirm){
    msg.textContent="As senhas não coincidem.";
    return;
  }

  msg.textContent="Salvando nova senha...";
  const {error}=await db.auth.updateUser({password});
  if(error){
    msg.textContent=error.message;
    return;
  }

  msg.textContent="Senha alterada com sucesso. Você já pode entrar com a nova senha.";
  setTimeout(async()=>{
    await db.auth.signOut();
    location.href="assessor.html";
  },1200);
});

let authObserverRegistered=false;
function registerAuthObserver(){
  if(authObserverRegistered) return;
  authObserverRegistered=true;

  db.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){
      $("#advisorBootLoader")?.classList.add("hidden");
      $("#advisorAuth").classList.add("hidden");
      $("#advisorPanel").classList.add("hidden");
      $("#advisorResetPassword").classList.remove("hidden");
    }

    if(event==="SIGNED_OUT"){
      currentUser=null;
    }
  });
}

$("#advisorLoginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=$("#advisorAuthMessage");
  const email=$("#advisorLoginEmail").value.trim();
  const password=$("#advisorLoginPassword").value;

  msg.textContent="Entrando...";

  try{
    const {data,error}=await db.auth.signInWithPassword({email,password});

    if(error){
      msg.textContent="Não foi possível entrar: "+error.message;
      return;
    }

    if(!data?.user){
      msg.textContent="Login realizado, mas o usuário não foi identificado. Atualize a página e tente novamente.";
      return;
    }

    msg.textContent="";
    await enterAdvisorPanel(data.user);
  }catch(err){
    console.error("Erro no login do assessor:",err);
    msg.textContent="O login foi processado, mas ocorreu um erro ao abrir o painel. Atualize a página e tente novamente.";
  }
});

$("#advisorSignupForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=$("#advisorAuthMessage");msg.textContent="Criando conta...";
  const meta={
    full_name:$("#advisorSignupName").value.trim(),
    company_name:$("#advisorSignupCompany").value.trim(),
    whatsapp:$("#advisorSignupWhatsapp").value.replace(/\D/g,""),
    city:$("#advisorSignupCity").value.trim()
  };
  const {data,error}=await db.auth.signUp({
    email:$("#advisorSignupEmail").value.trim(),
    password:$("#advisorSignupPassword").value,
    options:{data:meta}
  });
  if(error){msg.textContent=error.message;return;}
  if(data.session && data.user){
    msg.textContent="";
    await enterAdvisorPanel(data.user);
  }else{
    msg.textContent="A conta foi criada, mas a sessão não foi iniciada. Tente entrar com o mesmo e-mail e senha.";
    document.querySelectorAll(".auth-tab").forEach(b=>b.classList.toggle("active",b.dataset.authTab==="login"));
    $("#advisorLoginForm").classList.remove("hidden");
    $("#advisorSignupForm").classList.add("hidden");
    $("#advisorLoginEmail").value=$("#advisorSignupEmail").value.trim();
  }
});

$("#advisorBootRetry")?.addEventListener("click",()=>boot());

$("#advisorBootLogin")?.addEventListener("click",()=>{
  try{
    const prefix="sb-jljkpeoxisljrseqjhgm-auth-token";
    Object.keys(localStorage).forEach(key=>{
      if(key.includes(prefix)) localStorage.removeItem(key);
    });
    Object.keys(sessionStorage).forEach(key=>{
      if(key.includes(prefix)) sessionStorage.removeItem(key);
    });
  }catch(err){
    console.warn("Não foi possível limpar o armazenamento local:",err);
  }

  currentUser=null;
  $("#advisorBootLoader")?.classList.add("hidden");
  $("#advisorPanel").classList.add("hidden");
  $("#advisorResetPassword").classList.add("hidden");
  $("#advisorAuth").classList.remove("hidden");
  $("#advisorAuthMessage").textContent="Sessão deste navegador limpa. Entre novamente.";
});

$("#advisorLogout").addEventListener("click",async()=>{
  try{
    await withTimeout(db.auth.signOut(),7000,"Saída da conta");
  }catch(err){
    console.warn("Falha ao encerrar sessão pelo SDK:",err);
    try{
      const prefix="sb-jljkpeoxisljrseqjhgm-auth-token";
      Object.keys(localStorage).forEach(key=>{
        if(key.includes(prefix)) localStorage.removeItem(key);
      });
    }catch{}
  }
  location.reload();
});

boot().finally(()=>registerAuthObserver());