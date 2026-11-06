import { showNotification } from './notifications.js';

const grid = document.querySelector('#product-grid');
const catalogStatus = document.querySelector('#catalog-status');
const requestCount = document.querySelector('#request-count');
const requestStatus = document.querySelector('#request-status');
const requestEmpty = document.querySelector('#request-empty');
const requestItemsElement = document.querySelector('#request-items');
const clearRequestButton = document.querySelector('#clear-request');
const sendWhatsAppButton = document.querySelector('#send-whatsapp');
const categoryFilters = document.querySelector('.category-filters');
const productDetailsDialog = document.querySelector('#product-details-dialog');
const productDetailsContent = document.querySelector('#product-details-content');
const productDetailsClose = document.querySelector('#product-details-close');
const imageViewerDialog = document.querySelector('#image-viewer-dialog');
const imageViewerImage = document.querySelector('#image-viewer-image');
const imageViewerClose = document.querySelector('#image-viewer-close');
const adminAccessLink = document.querySelector('#admin-access-link');
const headerWhatsApp = document.querySelector('#header-whatsapp');
const copyrightYear = document.querySelector('#copyright-year');
const generalWhatsApp = document.querySelector('#general-whatsapp');
const contactUnavailable = document.querySelector('#contact-unavailable');
const generalContactUnavailable = document.querySelector('#contact-unavailable-general');
let whatsappPhone = '';
fetch('/api/contact', { headers: { Accept: 'application/json' }, cache: 'no-store' })
  .then((response) => response.ok ? response.json() : null)
  .then((contact) => {
    whatsappPhone = typeof contact?.whatsapp === 'string' ? contact.whatsapp : '';
    if (!whatsappPhone) {
      if (contactUnavailable) contactUnavailable.hidden = false;
      if (generalContactUnavailable) generalContactUnavailable.hidden = false;
      renderRequest();
      return;
    }
    const link = whatsappUrl('Hola, quisiera recibir información sobre sus trabajos de carpintería.');
    generalWhatsApp.href = link;
    generalWhatsApp.hidden = false;
    if (headerWhatsApp) {
      headerWhatsApp.href = link;
      headerWhatsApp.hidden = false;
    }
    contactUnavailable.hidden = true;
    generalContactUnavailable.hidden = true;
    renderRequest();
    if (catalogProducts.length) renderCatalog();
  }).catch(() => {
    if (contactUnavailable) contactUnavailable.hidden = false;
    if (generalContactUnavailable) generalContactUnavailable.hidden = false;
  });

function whatsappUrl(message) {
  return `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(message)}`;
}

function productWhatsApp(product) {
  const category = product.category_name ? ` de la categoría ${product.category_name}` : '';
  return whatsappUrl(`Hola, estoy interesado en el trabajo ${product.name}${category}. Quisiera recibir información y consultar las opciones disponibles. Enlace: ${productPublicUrl(product)}`);
}

if (copyrightYear) {
  const year = String(new Date().getFullYear());
  copyrightYear.dateTime = year;
  copyrightYear.textContent = year;
}

const standardDimensions = new Set(['width_m', 'height_m', 'depth_m', 'length_m', 'thickness_m']);
const maximumDimensionCount = 12;
const requests = new Map();
const selectionStorageKey = 'carpinteria.selection.ids.v1';
let productsById = new Map();
let catalogProducts = [];
let selectedCategory = '';
let lastDetailsTrigger = null;
let catalogRequestController = null;

function mediaUrl(media, size = 'preview') {
  if (!media?.url) return '';
  const url = new URL(media.url, window.location.origin);
  if (url.origin === window.location.origin) {
    if (size === 'original') url.searchParams.delete('size');
    else url.searchParams.set('size', size);
  }
  return url.href;
}

async function refreshAdminAccess() {
  try {
    const response = await fetch('/api/admin/status', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      adminAccessLink.hidden = true;
      return false;
    }
    const status = await response.json();
    const isOwner = status?.authenticated === true && status.role === 'owner';
    adminAccessLink.hidden = !isOwner;
    return isOwner;
  } catch {
    adminAccessLink.hidden = true;
    return false;
  }
}

refreshAdminAccess();
window.setInterval(refreshAdminAccess, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAdminAccess();
});
adminAccessLink.addEventListener('click', async (event) => {
  event.preventDefault();
  if (await refreshAdminAccess()) window.location.assign('/admin');
});

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function formatMeasurement(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits }).format(value);
}

function validDimensionKey(key) {
  return standardDimensions.has(key) || (typeof key === 'string' && /^custom_[a-f0-9]{32}$/.test(key));
}

function measurementSpecs(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.dimensions)) return null;
  if (config.dimensions.length < 1 || config.dimensions.length > maximumDimensionCount) return null;

  const seen = new Set();
  const dimensions = [];
  for (const item of config.dimensions) {
    if (!item || !validDimensionKey(item.key) || seen.has(item.key)) return null;
    const min = item.min_m === undefined ? 0 : item.min_m;
    const max = item.max_m;
    const hasMaximum = max !== undefined && max !== null;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0
      || (hasMaximum && (typeof max !== 'number' || !Number.isFinite(max) || max < 0 || min > max))) return null;
    if (typeof item.label !== 'string' || item.label.trim().length === 0) return null;

    seen.add(item.key);
    dimensions.push({
      key: item.key,
      label: item.label.trim(),
      help: typeof item.help === 'string' ? item.help : '',
      min,
      max: hasMaximum ? max : null,
      required: item.required !== false,
    });
  }
  return dimensions;
}

function fixedDimensionSpecs(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.dimensions)
    || config.dimensions.length < 1 || config.dimensions.length > maximumDimensionCount) return [];
  if (!config.dimensions.every((dimension) => dimension
    && typeof dimension.label === 'string' && dimension.label.trim().length > 0
    && typeof dimension.value_m === 'number' && Number.isFinite(dimension.value_m)
    && dimension.value_m >= 0)) return [];
  return config.dimensions;
}

function createMeasurementForm(product, dimensions) {
  const details = document.createElement('details');
  details.className = 'measurement-details';

  const summary = document.createElement('summary');
  summary.textContent = 'Indicar medidas';
  details.append(summary);

  const form = document.createElement('form');
  form.className = 'measurement-form';
  form.noValidate = true;
  form.dataset.productId = String(product.id);
  if (dimensions.length) {
    form.append(textElement('p', 'field-help', 'Escribe las medidas en metros. Aceptamos coma o punto decimal.'));
  }

  dimensions.forEach((dimension, index) => {
    const field = document.createElement('div');
    field.className = 'measure-field';

    const inputId = `measure-${product.id}-${index}`;
    const helpId = `${inputId}-help`;
    const conversionId = `${inputId}-conversion`;
    const errorId = `${inputId}-error`;

    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = inputId;
    label.textContent = `${dimension.label} (${dimension.required ? 'obligatorio' : 'opcional'})`;

    const input = document.createElement('input');
    input.id = inputId;
    input.name = dimension.key;
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.placeholder = 'Ejemplo: 1,70';
    input.dataset.min = String(dimension.min);
    input.dataset.max = dimension.max === null ? '' : String(dimension.max);
    input.dataset.required = String(dimension.required);
    input.setAttribute('aria-describedby', `${helpId} ${conversionId} ${errorId}`);

    const rangeHelp = dimension.max === null
      ? (dimension.min > 0 ? `Desde ${formatMeasurement(dimension.min)} m.` : 'Sin límites adicionales configurados.')
      : (dimension.min > 0
        ? `Entre ${formatMeasurement(dimension.min)} y ${formatMeasurement(dimension.max)} m.`
        : `Hasta ${formatMeasurement(dimension.max)} m.`);
    const helpText = [dimension.help.trim(), rangeHelp].filter(Boolean).join(' ');
    const help = textElement('p', 'field-help', helpText);
    help.id = helpId;

    const conversion = textElement('p', 'measurement-conversion', 'La equivalencia en centímetros aparecerá aquí.');
    conversion.id = conversionId;
    conversion.setAttribute('aria-live', 'polite');

    const error = textElement('p', 'field-error', '');
    error.id = errorId;
    error.setAttribute('aria-live', 'polite');

    field.append(label, input, help, conversion, error);
    form.append(field);
  });

  const outcome = textElement('p', 'estimate-outcome', dimensions.length
    ? 'Puedes indicar estas medidas para facilitar la consulta.'
    : 'Consulta directamente por este trabajo.');
  outcome.setAttribute('aria-live', 'polite');
  form.append(outcome);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button button-dark';
  submit.textContent = 'Guardar medidas y agregar';
  form.append(submit);
  details.append(form);
  return details;
}

function createProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';
  if (product.category_slug) card.dataset.category = product.category_slug;

  const media = Array.isArray(product.media) ? product.media : [];
  if (media.length) {
    const photo = media[0];
    const image = document.createElement('img');
    image.className = 'product-card-cover';
    image.src = mediaUrl(photo, 'large');
    image.alt = photo.altText?.trim() || `Fotografía de ${product.name}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      if (image.isConnected) image.replaceWith(textElement('p', 'product-media-unavailable', 'Fotografía pública no disponible.'));
    }, { once: true });
    const imageTrigger = document.createElement('button');
    imageTrigger.type = 'button';
    imageTrigger.className = 'product-card-image-trigger';
    imageTrigger.dataset.productDetails = String(product.id);
    imageTrigger.setAttribute('aria-label', `Ver fotografías y detalles de ${product.name}`);
    imageTrigger.append(image);
    card.append(imageTrigger);
  } else {
    card.append(textElement('p', 'product-media-unavailable', 'Sin fotografía pública disponible.'));
  }

  const content = document.createElement('div');
  content.className = 'product-card-body';
  if (product.category_name) content.append(textElement('p', 'eyebrow product-category', product.category_name));
  const title = document.createElement('h3');
  title.className = 'product-title';
  const titleTrigger = document.createElement('button');
  titleTrigger.type = 'button';
  titleTrigger.className = 'product-title-trigger';
  titleTrigger.dataset.productDetails = String(product.id);
  titleTrigger.textContent = product.name;
  title.append(titleTrigger);
  content.append(title);
  const actions = document.createElement('div');
  actions.className = 'product-card-actions';
  const selectionButton = document.createElement('button');
  selectionButton.type = 'button';
  selectionButton.className = 'button button-outline product-selection-button';
  selectionButton.dataset.productSelection = String(product.id);
  selectionButton.setAttribute('aria-pressed', String(requests.has(String(product.id))));
  selectionButton.textContent = requests.has(String(product.id)) ? 'Quitar de mi selección' : 'Agregar a mi selección';
  selectionButton.setAttribute('aria-label', `${selectionButton.textContent}: ${product.name}${product.category_name ? `, ${product.category_name}` : ''}`);
  actions.append(selectionButton);
  if (whatsappPhone) {
    const contact = document.createElement('a');
    contact.className = 'button button-dark product-whatsapp';
    contact.href = productWhatsApp(product);
    contact.target = '_blank';
    contact.rel = 'noopener noreferrer';
    contact.textContent = 'Consultar por WhatsApp';
    actions.append(contact);
  }
  content.append(actions);
  card.append(content);
  return card;
}

function openProductDetails(product, trigger) {
  lastDetailsTrigger = trigger;
  productDetailsContent.replaceChildren();

  const layout = document.createElement('div');
  layout.className = 'product-detail-layout';
  const photoFrame = document.createElement('div');
  photoFrame.className = 'product-detail-photo';
  const photos = (product.media ?? []).filter((media) => typeof media.url === 'string' && media.url);
  if (photos.length) {
    const gallery = document.createElement('div');
    gallery.className = 'product-detail-gallery';
    gallery.setAttribute('role', 'group');
    gallery.setAttribute('aria-label', `Galería de fotografías de ${product.name}`);
    const track = document.createElement('div');
    track.className = 'product-detail-gallery-track';
    track.tabIndex = 0;
    track.setAttribute('aria-label', 'Desliza para recorrer las fotografías');
    const counter = textElement('span', 'product-detail-gallery-counter', `1 de ${photos.length}`);
    counter.setAttribute('aria-live', 'polite');
    photos.forEach((current, index) => {
      const slide = document.createElement('div');
      slide.className = 'product-detail-gallery-slide';
      const image = document.createElement('img');
      image.src = mediaUrl(current, 'preview');
      image.alt = current.altText?.trim() || `Fotografía ${index + 1} de ${product.name}`;
      image.loading = index === 0 ? 'eager' : 'lazy';
      image.decoding = 'async';
      image.draggable = false;
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', `Ampliar fotografía ${index + 1} de ${photos.length}`);
      image.addEventListener('click', () => openImageViewer(current, product.name, index));
      if (index === 0) image.addEventListener('load', sizeProductDetailsDialog, { once: true });
      image.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openImageViewer(current, product.name, index);
        }
      });
      image.addEventListener('error', () => {
        if (image.isConnected) image.replaceWith(textElement('p', 'product-media-unavailable', 'Fotografía pública no disponible.'));
      }, { once: true });
      slide.append(image);
      track.append(slide);
    });
    if (photos.length > 1) {
      const loopSlide = track.firstElementChild.cloneNode(true);
      loopSlide.dataset.loopEnd = 'true';
      loopSlide.setAttribute('aria-hidden', 'true');
      const loopImage = loopSlide.querySelector('img');
      loopImage.alt = '';
      loopImage.tabIndex = -1;
      loopImage.removeAttribute('role');
      loopImage.removeAttribute('aria-label');
      loopImage.loading = 'lazy';
      track.append(loopSlide);
    }
    track.addEventListener('scroll', () => {
      const visibleIndex = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      const index = visibleIndex >= photos.length ? 0 : Math.min(photos.length - 1, visibleIndex);
      counter.textContent = `${index + 1} de ${photos.length}`;
      if (visibleIndex >= photos.length) {
        window.clearTimeout(track.wrapTimer);
        track.wrapTimer = window.setTimeout(() => { track.scrollLeft = 0; }, 100);
      }
    }, { passive: true });
    let dragStart = null;
    const moveDrag = (event) => {
      if (!dragStart || event.pointerId !== dragStart.pointerId) return;
      const delta = event.clientX - dragStart.x;
      if (Math.abs(delta) > 4) dragStart.moved = true;
      if (dragStart.moved) track.scrollLeft = dragStart.scrollLeft - delta;
    };
    track.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      dragStart = { pointerId: event.pointerId, x: event.clientX, scrollLeft: track.scrollLeft, moved: false };
      window.addEventListener('pointermove', moveDrag);
      window.addEventListener('pointerup', finishDrag);
      window.addEventListener('pointercancel', finishDrag);
    });
    function finishDrag(event) {
      if (!dragStart || (event?.pointerId !== undefined && event.pointerId !== dragStart.pointerId)) return;
      if (dragStart.moved && track.contains(event.target)) {
        track.dataset.draggedUntil = String(Date.now() + 250);
      }
      dragStart = null;
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    }
    track.addEventListener('click', (event) => {
      if (Date.now() <= Number(track.dataset.draggedUntil ?? 0)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    const controls = document.createElement('div');
    controls.className = 'product-detail-gallery-controls';
    controls.append(counter, textElement('span', 'gallery-hint', 'Desliza o arrastra · Pulsa la foto para ampliar'));
    gallery.append(track, controls);
    photoFrame.append(gallery);
  } else {
    photoFrame.append(textElement('p', 'product-media-unavailable', 'Sin fotografía pública disponible.'));
  }

  const information = document.createElement('div');
  information.className = 'product-detail-information';
  const detailsToggle = document.createElement('button');
  detailsToggle.type = 'button';
  detailsToggle.className = 'product-details-toggle';
  detailsToggle.textContent = 'Ocultar detalles';
  detailsToggle.setAttribute('aria-expanded', 'true');
  detailsToggle.setAttribute('aria-controls', `product-detail-extra-${product.id}`);
  let detailsExpanded = true;
  layout.classList.add('details-expanded');
  const extraPanel = document.createElement('div');
  extraPanel.className = 'product-detail-extra';
  extraPanel.id = `product-detail-extra-${product.id}`;
  extraPanel.setAttribute('aria-hidden', 'false');
  extraPanel.inert = false;
  const extraContent = document.createElement('div');
  extraContent.className = 'product-detail-extra-inner';
  extraPanel.append(extraContent);
  detailsToggle.addEventListener('click', () => {
    detailsExpanded = !detailsExpanded;
    layout.classList.toggle('details-expanded', detailsExpanded);
    detailsToggle.textContent = detailsExpanded ? 'Ocultar detalles' : 'Ver detalles';
    detailsToggle.setAttribute('aria-expanded', String(detailsExpanded));
    extraPanel.setAttribute('aria-hidden', String(!detailsExpanded));
    extraPanel.inert = !detailsExpanded;
    if (!detailsExpanded) detailsToggle.focus();
  });
  const title = textElement('h2', 'product-detail-title', product.name);
  title.id = 'product-detail-title';
  information.append(title);
  if (product.category_name) information.append(textElement('p', 'eyebrow product-category', product.category_name));
  if (product.description) extraContent.append(textElement('p', 'product-detail-description', product.description));
  const selectionButton = document.createElement('button');
  selectionButton.type = 'button';
  selectionButton.className = 'button button-outline product-detail-selection';
  selectionButton.dataset.productSelection = String(product.id);
  selectionButton.setAttribute('aria-pressed', String(requests.has(String(product.id))));
  selectionButton.textContent = requests.has(String(product.id)) ? 'Quitar de mi selección' : 'Agregar a mi selección';
  selectionButton.addEventListener('click', () => {
    const selected = toggleSelection(product);
    showNotification(selected ? `${product.name} se agregó a Mi selección.` : `${product.name} se quitó de Mi selección.`);
  });
  information.append(selectionButton);
  const directContact = document.createElement('a');
  directContact.className = 'button button-dark product-detail-whatsapp';
  directContact.textContent = 'Consultar por WhatsApp';
  directContact.target = '_blank';
  directContact.rel = 'noopener noreferrer';
  directContact.href = whatsappPhone ? productWhatsApp(product) : '#contacto';
  directContact.addEventListener('click', (event) => {
    if (!whatsappPhone) { event.preventDefault(); window.location.hash = 'contacto'; }
  });
  information.append(directContact);
  information.append(detailsToggle);
  const productVideos = product.videos?.length ? product.videos : (product.video ? [product.video] : []);
  for (const [index, productVideo] of productVideos.entries()) {
    if (!productVideo?.url || !['video/mp4', 'video/webm'].includes(productVideo.mimeType)) continue;
    const videoHeading = textElement('h3', 'product-detail-video-heading', productVideos.length > 1 ? `Video ${index + 1}` : 'Video del trabajo');
    const video = document.createElement('video');
    video.className = 'product-detail-video';
    video.controls = true;
    video.preload = 'none';
    video.playsInline = true;
    video.src = productVideo.url;
    video.setAttribute('aria-label', `${videoHeading.textContent} de ${product.name}`);
    extraContent.append(videoHeading, video);
  }

  const fixedDimensions = fixedDimensionSpecs(product.fixed_dimensions);
  if (fixedDimensions.length) {
    const section = document.createElement('section');
    section.className = 'product-detail-dimensions';
    section.append(textElement('h3', '', 'Dimensiones del mueble'));
    const list = document.createElement('dl');
    for (const dimension of fixedDimensions) {
      list.append(
        textElement('dt', '', dimension.label.trim()),
        textElement('dd', '', `${formatMeasurement(dimension.value_m, 3)} m`),
      );
    }
    section.append(list);
    extraContent.append(section);
  }

  const configuredDimensions = measurementSpecs(product.measurement_config);
  const dimensions = configuredDimensions ?? [];
  if (configuredDimensions) {
    extraContent.append(textElement('h3', 'product-detail-measure-heading', 'Medidas para consultar'));
  } else if (product.measurement_config) {
    extraContent.append(textElement('p', 'field-help', 'Las opciones de medidas están pendientes de configuración. Puedes describir tu solicitud abajo.'));
  }

  const formDetails = createMeasurementForm(product, dimensions);
  formDetails.open = true;
  formDetails.querySelector('summary')?.remove();
  formDetails.classList.add('product-detail-measurements');
  const form = formDetails.querySelector('.measurement-form');
  const notesField = document.createElement('div');
  notesField.className = 'product-detail-notes';
  const notesId = `product-notes-${product.id}`;
  const notesLabel = textElement('label', 'field-label', 'Medidas especiales, acabados o color de madera');
  notesLabel.htmlFor = notesId;
  const notes = document.createElement('textarea');
  notes.id = notesId;
  notes.name = 'special_request';
  notes.rows = 3;
  notes.maxLength = 1500;
  notes.placeholder = 'Escribe aquí los detalles que quieras consultar.';
  notesField.append(notesLabel, notes);
  form.insertBefore(notesField, form.querySelector('.estimate-outcome'));

  layout.append(photoFrame, information);
  extraContent.append(formDetails);
  information.append(extraPanel);
  productDetailsContent.append(layout);
  productDetailsDialog.showModal();
  sizeProductDetailsDialog();
  productDetailsClose.focus();
}

function sizeProductDetailsDialog() {
  if (!productDetailsDialog?.open) return;
  const image = productDetailsContent.querySelector('.product-detail-gallery-slide img');
  const ratio = image?.naturalWidth && image?.naturalHeight
    ? image.naturalWidth / image.naturalHeight
    : 4 / 3;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const isStacked = viewportWidth <= 900;

  if (isStacked) {
    const panelPadding = Math.min(25.6, Math.max(12, viewportWidth * .02));
    const contentWidth = Math.max(240, Math.min(viewportWidth * .94, 56 * 16) - panelPadding * 2 - 2);
    const maxPhotoHeight = viewportHeight * (viewportWidth <= 760 ? .46 : .52);
    const photoHeight = Math.min(maxPhotoHeight, contentWidth / ratio);
    productDetailsDialog.style.removeProperty('--detail-dialog-width');
    productDetailsDialog.style.setProperty('--detail-photo-height', `${Math.round(photoHeight)}px`);
    return;
  }

  const panelPadding = Math.min(25.6, Math.max(13.6, viewportWidth * .02));
  const gap = Math.min(20, Math.max(12, viewportWidth * .015));
  const maxDialogWidth = Math.min(viewportWidth * .92, 1100);
  const maxPhotoWidth = Math.max(240, (maxDialogWidth - gap - panelPadding * 2 - 2) * .55);
  const maxPhotoHeight = Math.min(680, viewportHeight * .85 - 40 - panelPadding * 2);
  const photoWidth = Math.min(maxPhotoWidth, maxPhotoHeight * ratio);
  const photoHeight = photoWidth / ratio;
  const photoColumnWidth = Math.max(photoWidth, 304 * 55 / 45);
  const infoWidth = Math.max(304, photoWidth * 45 / 55);
  const dialogWidth = photoColumnWidth + infoWidth + gap + panelPadding * 2 + 2;
  productDetailsDialog.style.setProperty('--detail-dialog-width', `${Math.round(dialogWidth)}px`);
  productDetailsDialog.style.setProperty('--detail-photo-height', `${Math.round(photoHeight)}px`);
}

function renderCategoryFilters() {
  const categories = [...new Map(catalogProducts
    .filter((product) => product.category_slug && product.category_name)
    .map((product) => [product.category_slug, product.category_name]))]
    .sort((first, second) => first[1].localeCompare(second[1], 'es'));
  if (!categories.length) {
    categoryFilters.replaceChildren();
    categoryFilters.hidden = true;
    selectedCategory = '';
    return;
  }

  const options = [['', 'Todos los muebles'], ...categories];
  categoryFilters.replaceChildren(...options.map(([slug, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-filter';
    button.dataset.categoryFilter = slug;
    button.setAttribute('aria-pressed', String(selectedCategory === slug));
    button.textContent = label;
    return button;
  }));
  categoryFilters.hidden = false;
}

function renderCatalog() {
  const visibleProducts = selectedCategory
    ? catalogProducts.filter((product) => product.category_slug === selectedCategory)
    : catalogProducts;
  const selectedLabel = catalogProducts.find((product) => product.category_slug === selectedCategory)?.category_name;
  const amount = visibleProducts.length;
  catalogStatus.textContent = `${amount} ${amount === 1 ? 'mueble' : 'muebles'}${selectedLabel ? ` · ${selectedLabel}` : ''}`;
  if (!amount) {
    grid.replaceChildren(textElement('p', 'catalog-empty', 'Todavía no hay muebles publicados en esta categoría.'));
    return;
  }
  grid.replaceChildren(...visibleProducts.map(createProductCard));
  openLinkedProduct();
}

function openLinkedProduct() {
  if (productDetailsDialog.open) return;
  const match = /^#trabajo-([1-9]\d*)$/.exec(window.location.hash);
  if (!match) return;
  const trigger = grid.querySelector(`[data-product-details="${CSS.escape(match[1])}"]`);
  if (trigger) openProductDetails(productsById.get(match[1]), trigger);
}

categoryFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category-filter]');
  if (!button) return;
  selectedCategory = button.dataset.categoryFilter;
  categoryFilters.querySelectorAll('[data-category-filter]').forEach((option) => {
    option.setAttribute('aria-pressed', String(option === button));
  });
  renderCatalog();
});

function parseMeters(raw) {
  const value = raw.trim();
  if (!value) return { error: 'Escribe una medida.' };
  if (value.startsWith('-')) return { error: 'La medida no puede ser negativa.' };

  const normalized = value.replace(',', '.');
  if (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(normalized)) {
    return { error: 'Escribe un número válido; puedes usar coma o punto decimal.' };
  }

  const meters = Number(normalized);
  return Number.isFinite(meters) ? { meters } : { error: 'Escribe un número válido.' };
}

function validateMeasurements(form) {
  const measurements = {};
  const errors = [];

  for (const input of form.querySelectorAll('input[name]')) {
    const parsed = parseMeters(input.value);
    const errorElement = document.getElementById(`${input.id}-error`);
    const conversionElement = document.getElementById(`${input.id}-conversion`);
    const required = input.dataset.required === 'true';

    if (!input.value.trim() && !required) {
      errorElement.textContent = '';
      conversionElement.textContent = 'Medida opcional sin indicar.';
      input.removeAttribute('aria-invalid');
      continue;
    }

    if (parsed.error) {
      errorElement.textContent = parsed.error;
      conversionElement.textContent = 'No se pudo calcular la equivalencia.';
      input.setAttribute('aria-invalid', 'true');
      errors.push(input);
      continue;
    }

    const min = Number(input.dataset.min);
    const max = input.dataset.max === '' ? null : Number(input.dataset.max);
    if (parsed.meters < min || (max !== null && parsed.meters > max)) {
      errorElement.textContent = max === null
        ? `Usa una medida de al menos ${formatMeasurement(min)} m.`
        : min > 0
          ? `Usa una medida entre ${formatMeasurement(min)} y ${formatMeasurement(max)} m.`
          : `Usa una medida de hasta ${formatMeasurement(max)} m.`;
      conversionElement.textContent = 'La medida debe estar dentro del rango indicado.';
      input.setAttribute('aria-invalid', 'true');
      errors.push(input);
      continue;
    }

    errorElement.textContent = '';
    conversionElement.textContent = `${formatMeasurement(parsed.meters, 3)} m = ${formatMeasurement(parsed.meters * 100, 2)} cm`;
    input.removeAttribute('aria-invalid');
    measurements[input.name] = parsed.meters;
  }

  return { measurements, errors };
}

function addRequest(product, measurements = {}, notes = '') {
  const key = String(product.id);
  const existing = requests.get(key);
  const item = {
    key,
    product,
    measurements: { ...(existing?.measurements ?? {}), ...measurements },
    notes: notes.trim() || existing?.notes || '',
  };
  requests.set(key, item);
  persistSelection();
  renderRequest();
  return item;
}

function toggleSelection(product) {
  const key = String(product.id);
  if (requests.has(key)) {
    requests.delete(key);
    persistSelection();
    renderRequest();
    return false;
  }
  addRequest(product);
  return true;
}

function persistSelection() {
  try { localStorage.setItem(selectionStorageKey, JSON.stringify([...requests.keys()])); } catch { /* Storage may be unavailable; in-memory selection remains active. */ }
}

function restoreSelection() {
  let stored = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(selectionStorageKey) ?? '[]');
    if (Array.isArray(parsed)) stored = parsed;
  } catch { /* Invalid or unavailable browser storage starts an empty selection. */ }
  const prior = new Map(requests);
  requests.clear();
  for (const id of stored) {
    const product = productsById.get(String(id));
    if (!product) continue;
    const key = String(product.id);
    const existing = prior.get(key);
    requests.set(key, { key, product, measurements: existing?.measurements ?? {}, notes: existing?.notes ?? '' });
  }
  persistSelection();
  renderRequest();
}

function requestSummary() {
  const lines = ['Hola, quisiera solicitar información y cotización sobre estos trabajos:', ''];
  let index = 0;
  for (const item of requests.values()) {
    index += 1;
    lines.push(`${index}. ${item.product.name}`);
    if (item.product.category_name) lines.push(`   Categoría: ${item.product.category_name}`);
    for (const [dimension, value] of Object.entries(item.measurements)) {
      const label = dimensionLabel(item.product, dimension);
      lines.push(`   ${label}: ${formatMeasurement(value, 3)} m`);
    }
    const fixed = fixedDimensionSpecs(item.product.fixed_dimensions);
    if (fixed.length) lines.push(`   Dimensiones disponibles: ${fixed.map((dimension) => `${dimension.label}: ${formatMeasurement(dimension.value_m, 3)} m`).join(' · ')}`);
    if (item.notes) lines.push(`   Información adicional: ${item.notes}`);
    lines.push(`   Enlace: ${productPublicUrl(item.product)}`, '');
  }
  lines.push('Quisiera recibir información sobre las opciones disponibles.');
  return lines.join('\n');
}

function productPublicUrl(product) {
  const url = new URL(window.location.href);
  url.hash = `trabajo-${product.id}`;
  return url.href;
}

let lastImageViewerTrigger = null;
function openImageViewer(media, productName, index) {
  if (!imageViewerDialog || !imageViewerImage) return;
  lastImageViewerTrigger = document.activeElement;
  imageViewerDialog.classList.add('is-sizing');
  imageViewerImage.alt = media.altText?.trim() || `Fotografía ${index + 1} de ${productName}`;
  imageViewerImage.addEventListener('load', sizeImageViewer, { once: true });
  imageViewerImage.addEventListener('error', () => imageViewerDialog.classList.remove('is-sizing'), { once: true });
  imageViewerImage.src = mediaUrl(media, 'original');
  imageViewerDialog.showModal();
  sizeImageViewer();
  document.body.classList.add('has-image-viewer');
  imageViewerClose.focus();
}

function sizeImageViewer() {
  if (!imageViewerDialog?.open || !imageViewerImage?.naturalWidth || !imageViewerImage?.naturalHeight) return;
  const ratio = imageViewerImage.naturalWidth / imageViewerImage.naturalHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const isMobile = viewportWidth <= 760;
  const isTablet = viewportWidth <= 900;
  const maxPanelWidth = Math.min(viewportWidth * (isMobile ? .94 : isTablet ? .9 : .85), 1200);
  const maxPanelHeight = Math.min(viewportHeight * (isMobile ? .9 : isTablet ? .9 : .88), 900);
  const frameWidth = Math.max(1, maxPanelWidth - 2);
  const frameHeight = Math.max(1, maxPanelHeight - 2);
  const imageWidth = Math.min(frameWidth, frameHeight * ratio);
  const imageHeight = imageWidth / ratio;
  imageViewerDialog.style.setProperty('--viewer-panel-width', `${Math.round(imageWidth + 2)}px`);
  imageViewerDialog.style.setProperty('--viewer-panel-height', `${Math.round(imageHeight + 2)}px`);
  imageViewerDialog.classList.remove('is-sizing');
}

window.addEventListener('resize', () => {
  sizeImageViewer();
  sizeProductDetailsDialog();
});

imageViewerClose?.addEventListener('click', () => imageViewerDialog.close());
imageViewerDialog?.addEventListener('click', (event) => {
  if (event.target === imageViewerDialog) imageViewerDialog.close();
});
imageViewerDialog?.addEventListener('close', () => {
  document.body.classList.remove('has-image-viewer');
  imageViewerDialog.classList.remove('is-sizing');
  imageViewerImage.removeAttribute('src');
  if (lastImageViewerTrigger?.isConnected) lastImageViewerTrigger.focus();
  lastImageViewerTrigger = null;
});

function dimensionLabel(product, key) {
  const configured = product.measurement_config?.dimensions?.find((dimension) => dimension.key === key)?.label;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return { width_m: 'Ancho', height_m: 'Alto', depth_m: 'Fondo', length_m: 'Largo', thickness_m: 'Espesor' }[key] ?? 'Otra medida';
}

function renderRequest() {
  requestItemsElement.replaceChildren();

  for (const item of requests.values()) {
    item.product = productsById.get(String(item.key)) ?? item.product;
    const row = document.createElement('li');
    row.className = 'selection-item';
    const photo = Array.isArray(item.product.media) ? item.product.media[0] : null;
    const photoFrame = document.createElement('div');
    photoFrame.className = 'selection-photo';
    if (photo) {
      const image = document.createElement('img');
      image.src = mediaUrl(photo, 'large');
      image.alt = photo.altText?.trim() || `Fotografía de ${item.product.name}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        if (!image.isConnected) return;
        image.replaceWith(textElement('span', 'request-item-photo-unavailable', 'Imagen no disponible'));
      }, { once: true });
      photoFrame.append(image);
    } else {
      photoFrame.append(textElement('span', 'request-item-photo-unavailable', 'Sin fotografía pública'));
    }
    const description = document.createElement('div');
    description.className = 'selection-item-copy';
    description.append(textElement('strong', 'selection-item-title', item.product.name));
    if (item.product.category_name) description.append(textElement('span', 'selection-item-detail', item.product.category_name));
    if (item.product.description) description.append(textElement('span', 'selection-item-detail selection-item-description', item.product.description));

    const measurements = Object.entries(item.measurements);
    if (measurements.length) {
      const labels = measurements.map(([key, value]) => {
        const label = dimensionLabel(item.product, key);
        return `${label}: ${formatMeasurement(value, 3)} m`;
      });
      description.append(textElement('span', 'selection-item-detail', `Medidas: ${labels.join(' · ')}`));
    }

    const modelDimensions = fixedDimensionSpecs(item.product.fixed_dimensions);
    if (modelDimensions.length) {
      const labels = modelDimensions.map((dimension) => `${dimension.label.trim()}: ${formatMeasurement(dimension.value_m, 3)} m`);
      description.append(textElement('span', 'selection-item-detail', `Medidas del modelo: ${labels.join(' · ')}`));
    }
    if (item.notes) description.append(textElement('span', 'selection-item-detail', `Información adicional: ${item.notes}`));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-text remove-item';
    remove.dataset.removeItem = item.key;
    remove.setAttribute('aria-label', `Quitar ${item.product.name}${item.product.category_name ? ` de la categoría ${item.product.category_name}` : ''} de mi selección`);
    remove.textContent = 'Quitar';
    row.append(photoFrame, description, remove);
    requestItemsElement.append(row);
  }

  const count = requests.size;
  requestItemsElement.dataset.count = String(count);
  requestCount.textContent = String(count);
  requestCount.setAttribute('aria-label', `${count} ${count === 1 ? 'trabajo' : 'trabajos'} seleccionados`);
  requestStatus.textContent = count
    ? `${count} ${count === 1 ? 'trabajo en' : 'trabajos en'} mi selección.`
    : 'Aún no has agregado trabajos.';
  requestEmpty.hidden = count > 0;
  clearRequestButton.disabled = count === 0;
  sendWhatsAppButton.disabled = count === 0 || !whatsappPhone;
  grid.querySelectorAll('[data-product-selection]').forEach((button) => {
    const selected = requests.has(String(button.dataset.productSelection));
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = selected ? 'Quitar de mi selección' : 'Agregar a mi selección';
    const product = productsById.get(String(button.dataset.productSelection));
    button.setAttribute('aria-label', `${button.textContent}: ${product?.name ?? ''}${product?.category_name ? `, ${product.category_name}` : ''}`);
  });
  productDetailsContent.querySelectorAll('.product-detail-selection').forEach((button) => {
    const selected = requests.has(String(button.dataset.productSelection));
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = selected ? 'Quitar de mi selección' : 'Agregar a mi selección';
  });
}

sendWhatsAppButton.addEventListener('click', () => {
  if (!whatsappPhone || !requests.size) return;
  window.open(whatsappUrl(requestSummary()), '_blank', 'noopener,noreferrer');
});

clearRequestButton.addEventListener('click', () => {
  requests.clear();
  persistSelection();
  renderRequest();
});

requestItemsElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-item]');
  if (!button) return;
  requests.delete(String(button.dataset.removeItem));
  persistSelection();
  renderRequest();
});

grid.addEventListener('click', async (event) => {
  const selectionButton = event.target.closest('[data-product-selection]');
  if (selectionButton) {
    const product = productsById.get(String(selectionButton.dataset.productSelection));
    if (product) {
      const selected = toggleSelection(product);
      showNotification(selected ? `${product.name} se agregó a Mi selección.` : `${product.name} se quitó de Mi selección.`);
    }
    return;
  }

  const detailsButton = event.target.closest('[data-product-details]');
  if (detailsButton) {
    const product = productsById.get(detailsButton.dataset.productDetails);
    if (product) openProductDetails(product, detailsButton);
    return;
  }

});

function closeProductDetails() {
  if (!productDetailsDialog.open) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    productDetailsDialog.close();
    return;
  }
  productDetailsDialog.classList.add('is-closing');
  window.setTimeout(() => {
    if (productDetailsDialog.open) productDetailsDialog.close();
  }, 160);
}

productDetailsClose.addEventListener('click', closeProductDetails);
productDetailsDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeProductDetails();
});
productDetailsDialog.addEventListener('click', (event) => {
  if (event.target === productDetailsDialog) closeProductDetails();
});
productDetailsDialog.addEventListener('close', () => {
  productDetailsDialog.classList.remove('is-closing');
  if (lastDetailsTrigger?.isConnected) lastDetailsTrigger.focus();
  lastDetailsTrigger = null;
});
function updateMeasurementInput(input) {
  const parsed = parseMeters(input.value);
  const conversion = document.getElementById(`${input.id}-conversion`);
  const error = document.getElementById(`${input.id}-error`);
  if (!input.value.trim()) {
    conversion.textContent = 'La equivalencia en centímetros aparecerá aquí.';
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  } else if (parsed.error) {
    conversion.textContent = 'No se pudo calcular la equivalencia.';
    error.textContent = parsed.error;
    input.setAttribute('aria-invalid', 'true');
  } else {
    const min = Number(input.dataset.min);
    const max = input.dataset.max === '' ? null : Number(input.dataset.max);
    conversion.textContent = `${formatMeasurement(parsed.meters, 3)} m = ${formatMeasurement(parsed.meters * 100, 2)} cm`;
    if (parsed.meters < min || (max !== null && parsed.meters > max)) {
      error.textContent = max === null
        ? `Usa una medida de al menos ${formatMeasurement(min)} m.`
        : min > 0
          ? `Usa una medida entre ${formatMeasurement(min)} y ${formatMeasurement(max)} m.`
          : `Usa una medida de hasta ${formatMeasurement(max)} m.`;
      input.setAttribute('aria-invalid', 'true');
    } else {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  }
}

grid.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name) updateMeasurementInput(event.target);
});
productDetailsDialog.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name && event.target.name !== 'special_request') {
    updateMeasurementInput(event.target);
  }
});

productDetailsDialog.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('.measurement-form')) return;
  event.preventDefault();
  const { measurements, errors } = validateMeasurements(form);
  if (errors.length) { errors[0].focus(); return; }
  const product = productsById.get(String(form.dataset.productId));
  if (!product) return;
  const notes = form.querySelector('[name="special_request"]')?.value ?? '';
  addRequest(product, measurements, notes);
  form.querySelector('.estimate-outcome').textContent = 'Se guardaron las medidas y notas en Mi selección.';
  showNotification(`${product.name} y sus medidas se guardaron en Mi selección.`, {
    actionLabel: 'Ver mi selección', actionHref: '#mi-seleccion',
  });
});

async function loadCatalog() {
  catalogRequestController?.abort();
  const controller = new AbortController();
  catalogRequestController = controller;
  try {
    let result;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch('/api/catalog', {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('catalog unavailable');
        result = await response.json();
        if (!Array.isArray(result.products)) throw new Error('invalid catalog response');
        break;
      } catch (error) {
        if (controller.signal.aborted) return;
        lastError = error;
        if (attempt === 2) throw error;
        await new Promise((resolve) => {
          const onAbort = () => {
            window.clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, 700 * (attempt + 1));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        if (controller.signal.aborted) return;
      }
    }
    if (!result) throw lastError ?? new Error('catalog unavailable');

    catalogProducts = result.products;
    productsById = new Map(catalogProducts.map((product) => [String(product.id), product]));
    restoreSelection();
    if (selectedCategory && !catalogProducts.some((product) => product.category_slug === selectedCategory)) {
      selectedCategory = '';
    }
    grid.setAttribute('aria-busy', 'false');
    if (!result.products.length) {
      catalogStatus.textContent = 'Todavía no hay muebles publicados.';
      categoryFilters.hidden = true;
      categoryFilters.replaceChildren();
      grid.replaceChildren(textElement('p', 'catalog-empty', 'Aún no hay trabajos publicados. Cuando haya modelos disponibles, podrás explorar sus fotografías y características.'));
      return;
    }

    renderCategoryFilters();
    renderCatalog();
  } catch {
    if (controller.signal.aborted) return;
    grid.setAttribute('aria-busy', 'false');
    catalogStatus.textContent = 'No fue posible cargar los muebles. Inténtalo de nuevo más tarde.';
    categoryFilters.hidden = true;
    grid.replaceChildren(textElement('p', 'catalog-error', 'No pudimos cargar el catálogo en este momento.'));
  } finally {
    if (catalogRequestController === controller) catalogRequestController = null;
  }
}

loadCatalog();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadCatalog();
});
