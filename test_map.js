const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  try {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    // Simulate an average mobile device
    await page.setViewport({ width: 390, height: 844 }); 
    
    console.log('Navigating to http://localhost:5000...');
    await page.goto('http://localhost:5000', { waitUntil: 'networkidle2' });
    
    console.log('Clicking student role...');
    await page.evaluate(() => {
      document.querySelector('.role-btn[onclick="selectRole(\'student\')"]').click();
    });
    
    // Wait for animation
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('Clicking Track Bus tab...');
    await page.evaluate(() => {
      document.getElementById('tab-find').click();
    });
    
    // Wait for map to initialize and tiles to load
    await new Promise(r => setTimeout(r, 2000));
    
    console.log('Taking screenshot...');
    const path = 'C:\\Users\\DELL 0424\\.gemini\\antigravity\\brain\\1b6fdca8-7cb6-40d1-93af-56f2c192a7a6\\map_screenshot.png';
    await page.screenshot({ path: path, fullPage: true });
    
    console.log('Screenshot saved to ' + path);
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  }
})();
