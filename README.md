# Catálogo de Imóveis

Sistema próprio para catálogo e gestão de imóveis para locação.

## Estrutura

- Catálogo público com filtros por localização, tipo, preço, mobília, quartos e status.
- Página individual do imóvel com fotos, valores, mobília, itens inclusos, mapa, universidades próximas e WhatsApp.
- Painel administrativo protegido pelo Supabase Auth + RLS.
- Cadastro manual de imóveis, proprietários, locatários, locações e lançamentos financeiros.
- Status do imóvel controlado manualmente: Disponível, Alugado ou Oculto.
- Imóveis alugados permanecem no catálogo com tarja vermelha **ALUGADO**.
- Fotos armazenadas no Supabase Storage.
- Vídeos por link do YouTube.
- Preparado para cálculo de distância real até universidades via Google Routes API.

## Backend

Projeto Supabase exclusivo deste sistema.

## Deploy

GitHub Pages por workflow automático.
