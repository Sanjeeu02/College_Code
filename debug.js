const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.static(__dirname));
const server = app.listen(5000, async () => {
  console.log('Server running on 5000');
  
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('BROWSER_LOG:', msg.text()));
  page.on('pageerror', error => console.log('BROWSER_ERROR:', error.message));
  
  await page.goto('http://localhost:5000', { waitUntil: 'networkidle2' });
  
  await page.evaluate(() => { selectRole('student'); });
  await new Promise(r => setTimeout(r, 1000));
  
  await page.evaluate(() => {
    const cc = document.querySelector('#college-code-screen');
    if (!cc.classList.contains('hidden')) {
        document.querySelector('#college-code-input').value = 'TEST';
        document.querySelector('button[onclick="verifyCollegeCode()"]').click();
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  await page.click('#tab-find');
  await new Promise(r => setTimeout(r, 1000));
  
  await page.evaluate(() => { 
      S.allBuses = { 'dummy': { accessCode: '123' } };
      _doStartTracking('dummy'); 
  });
  await new Promise(r => setTimeout(r, 2000));
  
  const h = await page.evaluate(() => document.querySelector('#map-view').clientHeight);
  const w = await page.evaluate(() => document.querySelector('#map-view').clientWidth);
  console.log('map-view dimensions:', w, 'x', h);
  
  await browser.close();
  server.close();
});
