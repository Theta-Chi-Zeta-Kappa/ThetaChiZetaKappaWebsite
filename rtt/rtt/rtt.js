(() => {
  const body = document.body;
  const loader = document.getElementById('loading-screen');
  const heroMedia = document.querySelector('.hero-media[data-src]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let heroStarted = false;
  let loaderDismissed = false;

  body.classList.add('loading');

  // Do not give the browser the hero GIF URL until the splash screen is gone.
  // This makes the shirt reveal begin only after visitors can actually see it.
  const startHero = () => {
    if (heroStarted || !heroMedia) return;
    heroStarted = true;

    const source = heroMedia.dataset.src;
    if (!source) return;

    heroMedia.addEventListener('load', () => {
      heroMedia.classList.add('is-ready');
    }, { once: true });

    heroMedia.src = source;
    heroMedia.removeAttribute('data-src');
  };

  const dismissLoader = () => {
    if (loaderDismissed) return;
    loaderDismissed = true;
    body.classList.remove('loading');

    if (!loader || reduceMotion) {
      startHero();
      return;
    }

    loader.classList.add('is-hidden');

    const onFadeComplete = (event) => {
      if (event.target !== loader || event.propertyName !== 'opacity') return;
      loader.removeEventListener('transitionend', onFadeComplete);
      startHero();
    };

    loader.addEventListener('transitionend', onFadeComplete);

    // Safety fallback in case transitionend does not fire.
    window.setTimeout(startHero, 650);
  };

  window.addEventListener('load', () => {
    window.setTimeout(dismissLoader, 1650);
  });
  window.setTimeout(dismissLoader, 3200);

  const colorButtons = [...document.querySelectorAll('.color-choice')];
  const sizeSelect = document.getElementById('size');
  const qtyMinus = document.getElementById('qty-minus');
  const qtyPlus = document.getElementById('qty-plus');
  const qtyOutput = document.getElementById('quantity');
  const summary = document.getElementById('selection-summary');
  const total = document.getElementById('total-price');
  const addButton = document.getElementById('add-to-order');
  const addStatus = document.getElementById('add-status');
  const checkoutButton = document.getElementById('square-checkout');
  const checkoutStatus = document.getElementById('checkout-status');
  const cartItems = document.getElementById('cart-items');
  const cartEmpty = document.getElementById('cart-empty');
  const cartCount = document.getElementById('cart-count');
  const cartTotal = document.getElementById('cart-total');
  const cartTotalRow = document.getElementById('cart-total-row');

  let color = 'Charcoal';
  let quantity = 1;
  const price = 22;
  const MAX_ORDER_QTY = 10;
  const CART_STORAGE_KEY = 'rtt2026Cart';

  const galleryMain = document.getElementById('shirt-gallery-main');
  const galleryLabel = document.getElementById('gallery-view-label');
  const galleryThumbs = [...document.querySelectorAll('.gallery-thumb')];
  const frontThumbImage = document.getElementById('shirt-thumb-front');
  const backThumbImage = document.getElementById('shirt-thumb-back');
  let galleryView = 'front';

  const galleryAssets = {
    Charcoal: {
      front: {
        display: './assets/shirts/charcoal-front-display.webp',
        thumb: './assets/shirts/charcoal-front-thumb.webp'
      },
      back: {
        display: './assets/shirts/charcoal-back-display.webp',
        thumb: './assets/shirts/charcoal-back-thumb.webp'
      }
    },
    'Light Pink': {
      front: {
        display: './assets/shirts/pink-front-display.webp',
        thumb: './assets/shirts/pink-front-thumb.webp'
      },
      back: {
        display: './assets/shirts/pink-back-display.webp',
        thumb: './assets/shirts/pink-back-thumb.webp'
      }
    }
  };

  const commerceColor = {
    'Charcoal': 'charcoal',
    'Light Pink': 'light-pink'
  };

  const colorLabel = {
    'charcoal': 'Charcoal',
    'light-pink': 'Light Pink'
  };

  const sizeLabel = {
    S: 'Small',
    M: 'Medium',
    L: 'Large',
    XL: 'XL',
    '2XL': '2XL'
  };

  const CHECKOUT_ENDPOINT = 'https://tczk-admin-api.jackkinn13.workers.dev/commerce/create-checkout';

  const loadCart = () => {
    try {
      const value = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(item =>
        ['charcoal', 'light-pink'].includes(item?.color) &&
        ['S', 'M', 'L', 'XL', '2XL'].includes(item?.size) &&
        Number.isInteger(item?.quantity) && item.quantity > 0
      );
    } catch (_) {
      return [];
    }
  };

  let cart = loadCart();

  const saveCart = () => {
    try { localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart)); } catch (_) {}
  };

  const totalCartQuantity = () => cart.reduce((sum, item) => sum + item.quantity, 0);

  const updateGallery = ({ resetView = false } = {}) => {
    if (resetView) galleryView = 'front';
    const set = galleryAssets[color];
    if (!set) return;

    if (frontThumbImage) {
      frontThumbImage.src = set.front.thumb;
      frontThumbImage.alt = `${color} shirt front thumbnail`;
    }
    if (backThumbImage) {
      backThumbImage.src = set.back.thumb;
      backThumbImage.alt = `${color} shirt back thumbnail`;
    }

    const current = set[galleryView];
    if (galleryMain && current) {
      galleryMain.classList.remove('is-switching');
      requestAnimationFrame(() => {
        galleryMain.classList.add('is-switching');
        galleryMain.src = current.display;
        galleryMain.alt = `${color} Rock the Tundra 2026 shirt, ${galleryView} view`;
      });
    }
    if (galleryLabel) galleryLabel.textContent = `${color.toUpperCase()} • ${galleryView.toUpperCase()}`;

    galleryThumbs.forEach(button => {
      const selected = button.dataset.view === galleryView;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  };

  galleryThumbs.forEach(button => {
    button.addEventListener('click', () => {
      galleryView = button.dataset.view || 'front';
      updateGallery();
    });
  });

  const updateSummary = () => {
    const selectedSizeLabel = sizeSelect?.options[sizeSelect.selectedIndex]?.text || 'Medium';
    if (summary) summary.textContent = `${quantity} × ${color} • ${selectedSizeLabel}`;
    if (total) total.textContent = `$${price * quantity}`;
    if (qtyOutput) qtyOutput.textContent = quantity;
  };

  const renderCart = () => {
    const itemCount = totalCartQuantity();
    const amount = itemCount * price;

    if (cartCount) cartCount.textContent = `${itemCount} ${itemCount === 1 ? 'ITEM' : 'ITEMS'}`;
    if (cartTotal) cartTotal.textContent = `$${amount}`;
    if (cartEmpty) cartEmpty.hidden = cart.length > 0;
    if (cartTotalRow) cartTotalRow.hidden = cart.length === 0;
    if (checkoutButton) checkoutButton.disabled = cart.length === 0;

    if (!cartItems) return;
    cartItems.replaceChildren();

    cart.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'cart-item';

      const details = document.createElement('div');
      details.className = 'cart-item-details';
      const title = document.createElement('strong');
      title.textContent = `${colorLabel[item.color]} • ${sizeLabel[item.size]}`;
      const meta = document.createElement('span');
      meta.textContent = `${item.quantity} × $${price}`;
      details.append(title, meta);

      const controls = document.createElement('div');
      controls.className = 'cart-item-controls';

      const linePrice = document.createElement('strong');
      linePrice.textContent = `$${item.quantity * price}`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cart-remove';
      remove.textContent = 'REMOVE';
      remove.setAttribute('aria-label', `Remove ${colorLabel[item.color]} ${sizeLabel[item.size]} from order`);
      remove.addEventListener('click', () => {
        cart.splice(index, 1);
        saveCart();
        renderCart();
      });

      controls.append(linePrice, remove);
      row.append(details, controls);
      cartItems.append(row);
    });
  };

  colorButtons.forEach(button => {
    button.addEventListener('click', () => {
      color = button.dataset.color;
      colorButtons.forEach(other => {
        const selected = other === button;
        other.classList.toggle('is-selected', selected);
        other.setAttribute('aria-pressed', String(selected));
      });
      updateSummary();
      updateGallery({ resetView: true });
    });
  });

  sizeSelect?.addEventListener('change', updateSummary);
  qtyMinus?.addEventListener('click', () => {
    quantity = Math.max(1, quantity - 1);
    updateSummary();
  });
  qtyPlus?.addEventListener('click', () => {
    quantity = Math.min(MAX_ORDER_QTY, quantity + 1);
    updateSummary();
  });

  addButton?.addEventListener('click', () => {
    const size = sizeSelect?.value;
    const apiColor = commerceColor[color];
    if (!size || !apiColor) return;

    const currentTotal = totalCartQuantity();
    if (currentTotal + quantity > MAX_ORDER_QTY) {
      if (addStatus) {
        addStatus.textContent = `Online checkout is limited to ${MAX_ORDER_QTY} shirts per order.`;
        addStatus.classList.add('is-error');
      }
      return;
    }

    const existing = cart.find(item => item.color === apiColor && item.size === size);
    if (existing) existing.quantity += quantity;
    else cart.push({ color: apiColor, size, quantity });

    saveCart();
    renderCart();
    if (addStatus) {
      addStatus.textContent = `${quantity} × ${color} ${sizeLabel[size]} added to your order.`;
      addStatus.classList.remove('is-error');
    }
    quantity = 1;
    updateSummary();
  });

  checkoutButton?.addEventListener('click', async () => {
    if (checkoutButton.disabled || cart.length === 0) return;

    checkoutButton.disabled = true;
    checkoutButton.classList.add('is-loading');
    checkoutButton.textContent = 'CREATING CHECKOUT…';
    if (checkoutStatus) {
      checkoutStatus.textContent = '';
      checkoutStatus.classList.remove('is-error');
    }

    try {
      const response = await fetch(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'rtt-2026',
          items: cart
        })
      });

      let data = null;
      try { data = await response.json(); } catch (_) {}

      if (!response.ok || !data?.ok || !data?.checkoutUrl) {
        throw new Error(data?.error || 'Unable to create checkout.');
      }

      window.location.assign(data.checkoutUrl);
    } catch (error) {
      console.error('Square checkout error:', error);
      checkoutButton.disabled = false;
      checkoutButton.classList.remove('is-loading');
      checkoutButton.textContent = 'CHECKOUT WITH SQUARE';
      if (checkoutStatus) {
        checkoutStatus.textContent = 'Checkout could not be started. Please try again.';
        checkoutStatus.classList.add('is-error');
      }
    }
  });

  updateSummary();
  updateGallery();
  renderCart();
})();
