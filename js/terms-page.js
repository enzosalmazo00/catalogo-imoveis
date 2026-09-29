(function(){
  if(new URLSearchParams(location.search).get("embedded")==="1"){
    document.body.classList.add("terms-embedded");
  }
})();