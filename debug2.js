const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.static(__dirname));
const server = app.listen(5001, async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER_LOG:', msg.text()));
  page.on('pageerror', error => console.log('BROWSER_ERROR:', error.message));
  
  await page.goto('http://localhost:5001', { waitUntil: 'networkidle2' });
  
  // Expose a function to run after page loads
  await page.evaluate(async () => {
      // Fake S data
      S.allBuses = { 'dummy': { accessCode: '123' } };
      // directly show map view
      const mapView = document.querySelector('#map-view');
      mapView.classList.remove('hidden');
      
      const mapH = _getMapHeight();
      mapView.style.height = mapH + 'px';
      mapView.style.minHeight = '300px';

      const mapEl = document.querySelector('#live-map');
      if (mapEl) {
        mapEl.style.width     = '100%';
        mapEl.style.height    = mapH + 'px';
        mapEl.style.minHeight = '300px';
      }

      console.log("Calling initMap");
      try {
         initMap();
         console.log("initMap success");
      } catch (e) {
         console.log("initMap crashed: " + e.message);
      }
  });
  
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
  server.close();
});
