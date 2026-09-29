(function(){
  var FORCE_KEY="sb-jljkpeoxisljrseqjhgm-auth-token";

  function byId(id){ return document.getElementById(id); }

  window.forceAdvisorLogin=function(){
    try{
      localStorage.removeItem(FORCE_KEY);
      sessionStorage.removeItem(FORCE_KEY);
      Object.keys(localStorage).forEach(function(k){
        if(k.indexOf("sb-jljkpeoxisljrseqjhgm-auth-token")!==-1) localStorage.removeItem(k);
      });
    }catch(e){}

    var loader=byId("advisorBootLoader");
    var auth=byId("advisorAuth");
    var panel=byId("advisorPanel");
    var reset=byId("advisorResetPassword");

    if(loader) loader.classList.add("hidden");
    if(panel) panel.classList.add("hidden");
    if(reset) reset.classList.add("hidden");
    if(auth) auth.classList.remove("hidden");

    var msg=byId("advisorAuthMessage");
    if(msg) msg.textContent="Sessão deste aparelho limpa. Entre novamente.";
  };

  window.addEventListener("DOMContentLoaded",function(){
    setTimeout(function(){
      var loader=byId("advisorBootLoader");
      if(!loader || loader.classList.contains("hidden")) return;

      var spinner=byId("advisorBootSpinner");
      var title=byId("advisorBootTitle");
      var text=byId("advisorBootText");
      var actions=byId("advisorBootActions");

      if(spinner) spinner.classList.add("hidden");
      if(title) title.textContent="Este navegador não respondeu.";
      if(text) text.textContent="Limpe apenas a sessão deste site e entre novamente. Sua conta e seus anúncios não serão apagados.";
      if(actions) actions.classList.remove("hidden");

      var retry=byId("advisorBootRetry");
      var login=byId("advisorBootLogin");

      if(retry) retry.addEventListener("click",function(){ location.reload(); });
      if(login) login.addEventListener("click",function(){ window.forceAdvisorLogin(); });
    },6000);
  });
})();