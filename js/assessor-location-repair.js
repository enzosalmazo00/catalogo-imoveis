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

repairMissingPropertyCoordinates();
