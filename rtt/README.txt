ROCK THE TUNDRA 2026 MICROSITE — DRAFT

Intended location in the main TCZK repository:
/rtt/

Files:
- index.html
- rtt.css
- rtt.js
- assets/zk-logo.png
- assets/knight.gif
- assets/loading-bar.gif
- assets/rtt-shirt-hero.gif

Current status:
- Loading splash implemented with knight + loading bar GIFs.
- Sticky Theta Chi Zeta Kappa header.
- Transparent shirt hero GIF integrated.
- Mission placeholder uses the supplied language.
- Color / size / quantity preorder UI is functional locally.
- $22 total updates with quantity.
- Square checkout is intentionally disabled until the final Square link/workflow is decided.

To publish in the main repo, copy this entire folder as /rtt/.

V3 SHIRT GALLERY
The preorder area now includes a responsive front/back shirt gallery beside the selector card.
Expected WebP files are listed in assets/shirts/README.txt. These correspond to the display and thumbnail outputs from the existing gallery batch processor.


V4 LOCAL CHECKOUT TESTING
-------------------------
1. Deploy the localhost-enabled Cloudflare Worker.
2. Double-click server.bat.
3. The site opens at http://localhost:8000.
4. Pick color, size, and quantity, then click CHECKOUT WITH SQUARE.
5. The page sends only event/color/size/quantity to the Worker. The Worker resolves the Square catalog variation and returns a Square-hosted checkout URL.

Public sizes in this build: M, L, XL, 2XL.
The shirt gallery still expects the eight WebP files listed in assets/shirts/README.txt.


V5 MULTI-SHIRT CART
- Customers can add multiple color/size combinations before a single Square checkout.
- Cart is stored locally in the browser while testing/shopping.
- Online cart is limited to 10 total shirts per checkout.
- Requires the matching cart-capable Cloudflare Worker update.
V6 UPDATE
- Added Small (S) to the public shirt size selector and cart validation.
- Square variation naming expects RTT26-CH-S and RTT26-LP-S.
