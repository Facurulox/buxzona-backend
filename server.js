// 1. Importamos las herramientas
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

// 2. Configuraciones
const PORT = process.env.PORT || 3000;
const PROFIT_MARGIN_USD = 1.70;
const ROBUX_AMOUNT_TO_PRICE = 1000;
const CHEAPBUX_URL = 'https://www.cheapbux.gg/';
const PRICE_SELECTOR = '.MuiTypography-root.MuiTypography-h4.css-wsw0vr'; 

const app = express();
app.use(cors());

// ======================= LA MEJORA CLAVE =======================
// Precios de respaldo que usamos si todo lo demás falla.
// Esto asegura que el servidor SIEMPRE tenga precios para ofrecer.
const backupPrices = {
  usd: { rate: 0.0043, symbol: '$', min: 2.0 },
  rub: { rate: 0.344, symbol: '₽', min: 160 }
};

// Empezamos con los precios de respaldo.
let cachedPrices = backupPrices;
let lastFetch = 0;
// ===============================================================

async function updatePrices() {
  console.log('Intentando actualizar precios en segundo plano...');
  try {
    const { data: cheapbuxHtml } = await axios.get(CHEAPBUX_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
    });
    const $ = cheerio.load(cheapbuxHtml);
    
    const priceText = $(PRICE_SELECTOR).first().text().replace('$', '').trim();
    const basePricePer1000Robux = parseFloat(priceText);

    if (isNaN(basePricePer1000Robux)) {
      throw new Error('No se pudo extraer el precio base de cheapbux.gg.');
    }

    const { data: currencyData } = await axios.get('https://open.er-api.com/v6/latest/USD');
    const usdToRubRate = currencyData.rates.RUB;
    if (!usdToRubRate) throw new Error('No se pudo obtener la tasa de cambio.');

    const finalPriceUSD = basePricePer1000Robux + PROFIT_MARGIN_USD;
    const finalPriceRUB = finalPriceUSD * usdToRubRate;

    const rateUSD = finalPriceUSD / ROBUX_AMOUNT_TO_PRICE;
    const rateRUB = finalPriceRUB / ROBUX_AMOUNT_TO_PRICE;
    
    const minRUB = 2.0 * usdToRubRate;

    cachedPrices = {
      usd: { rate: rateUSD, symbol: '$', min: 2.0 },
      rub: { rate: rateRUB, symbol: '₽', min: parseFloat(minRUB.toFixed(0)) }
    };

    lastFetch = Date.now();
    console.log('¡Éxito! Precios actualizados desde las APIs:', cachedPrices);

  } catch (error) {
    console.error('Fallo al actualizar precios (se seguirán usando los precios de respaldo):', error.message);
  }
}

app.get('/get-prices', (req, res) => {
  // Solo intentamos actualizar si ha pasado más de 10 minutos
  if (Date.now() - lastFetch > 10 * 60 * 1000) {
    updatePrices();
  }
  
  // Siempre respondemos con los precios que tenemos (los de respaldo o los actualizados)
  return res.json(cachedPrices);
});

app.listen(PORT, () => {
  console.log(`Servidor Buxzona escuchando en el puerto ${PORT}`);
  console.log('Usando precios de respaldo iniciales:', cachedPrices);
  // Intentamos la primera actualización justo después de arrancar
  updatePrices();
});