import { showNotification } from './notifications.js';

const grid = document.querySelector('#product-grid');
const catalogStatus = document.querySelector('#catalog-status');
const requestCount = document.querySelector('#request-count');
const requestStatus = document.querySelector('#request-status');
const requestEmpty = document.querySelector('#request-empty');
const requestItemsElement = document.querySelector('#request-items');
const requestText = document.querySelector('#request-text');
const copyRequestButton = document.querySelector('#copy-request');
const clearRequestButton = document.querySelector('#clear-request');
const sendWhatsAppButton = document.querySelector('#send-whatsapp');
const categoryFilters = document.querySelector('.category-filters');
const productDetailsDialog = document.querySelector('#product-details-dialog');
const productDetailsContent = document.querySelector('#product-details-content');
const productDetailsClose = document.querySelector('#product-details-close');
const adminAccessLink = document.querySelector('#admin-access-link');
const copyrightYear = document.querySelector('#copyright-year');

if (copyrightYear) {
  const year = String(new Date().getFullYear());
  copyrightYear.dateTime = year;
  copyrightYear.textContent = year;
}

const standardDimensions = new Set(['width_m', 'height_m', 'depth_m', 'length_m', 'thickness_m']);
const maximumDimensionCount = 12;
const requests = new Map();
let requestSequence = 0;
let productsById = new Map();
let catalogProducts = [];
let selectedCategory = '';
let lastDetailsTrigger = null;
let catalogRequestController = null;

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

function formatMoney(value, currency) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  const code = String(currency ?? '').trim();
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(code)) return null;

  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return null;
  }
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
    ? 'Completa las medidas para revisar el precio disponible.'
    : 'Puedes agregar este mueble a tu solicitud de cotización.');
  outcome.setAttribute('aria-live', 'polite');
  form.append(outcome);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'button button-dark';
  submit.textContent = 'Solicitar cotización';
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
    image.src = photo.url;
    image.alt = photo.altText?.trim() || `Fotografía de ${product.name}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      if (image.isConnected) image.replaceWith(textElement('p', 'product-media-unavailable', 'Fotografía pública no disponible.'));
    }, { once: true });
    card.append(image);
  } else {
    card.append(textElement('p', 'product-media-unavailable', 'Sin fotografía pública disponible.'));
  }

  if (product.category_name) card.append(textElement('p', 'eyebrow product-category', product.category_name));
  card.append(textElement('h3', 'product-title', product.name));
  const price = formatMoney(product.price, product.currency);
  card.append(textElement('p', 'product-price', price ?? 'Precio por cotizar'));
  const detailsButton = document.createElement('button');
  detailsButton.type = 'button';
  detailsButton.className = 'product-detail-trigger';
  detailsButton.dataset.productDetails = String(product.id);
  detailsButton.textContent = 'Ver detalles';
  detailsButton.setAttribute('aria-haspopup', 'dialog');
  card.append(detailsButton);
  return card;
}

function openProductDetails(product, trigger) {
  lastDetailsTrigger = trigger;
  productDetailsContent.replaceChildren();

  const layout = document.createElement('div');
  layout.className = 'product-detail-layout';
  const photo = product.media?.find((media) => typeof media.url === 'string' && media.url);
  const photoFrame = document.createElement('div');
  photoFrame.className = 'product-detail-photo';
  const photos = (product.media ?? []).filter((media) => typeof media.url === 'string' && media.url);
  if (photo) {
    const gallery = document.createElement('div');
    gallery.className = 'product-detail-gallery';
    gallery.setAttribute('role', 'group');
    gallery.setAttribute('aria-label', `Galería de fotografías de ${product.name}`);
    const image = document.createElement('img');
    image.src = photo.url;
    image.alt = photo.altText?.trim() || `Fotografía 1 de ${product.name}`;
    image.loading = 'eager';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      if (image.isConnected) image.replaceWith(textElement('p', 'product-media-unavailable', 'Fotografía pública no disponible.'));
    }, { once: true });
    gallery.append(image);
    if (photos.length > 1) {
      const controls = document.createElement('div');
      controls.className = 'product-detail-gallery-controls';
      let activeIndex = 0;
      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'button button-outline';
      previous.textContent = 'Anterior';
      previous.setAttribute('aria-label', 'Ver fotografía anterior');
      const counter = textElement('span', 'product-detail-gallery-counter', `1 de ${photos.length}`);
      counter.setAttribute('aria-live', 'polite');
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'button button-outline';
      next.textContent = 'Siguiente';
      next.setAttribute('aria-label', 'Ver fotografía siguiente');
      const showPhoto = (index) => {
        activeIndex = (index + photos.length) % photos.length;
        const current = photos[activeIndex];
        image.src = current.url;
        image.alt = current.altText?.trim() || `Fotografía ${activeIndex + 1} de ${product.name}`;
        counter.textContent = `${activeIndex + 1} de ${photos.length}`;
      };
      previous.addEventListener('click', () => showPhoto(activeIndex - 1));
      next.addEventListener('click', () => showPhoto(activeIndex + 1));
      controls.append(previous, counter, next);
      gallery.append(controls);
    }
    photoFrame.append(gallery);
  } else {
    photoFrame.append(textElement('p', 'product-media-unavailable', 'Sin fotografía pública disponible.'));
  }

  const information = document.createElement('div');
  information.className = 'product-detail-information';
  const title = textElement('h2', 'product-detail-title', product.name);
  title.id = 'product-detail-title';
  information.append(title);
  if (product.category_name) information.append(textElement('p', 'eyebrow product-category', product.category_name));
  if (product.description) information.append(textElement('p', 'product-detail-description', product.description));
  const price = formatMoney(product.price, product.currency);
  information.append(textElement('p', 'product-detail-price', price ?? 'Precio por cotizar'));
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
    information.append(videoHeading, video);
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
    information.append(section);
  }

  const configuredDimensions = measurementSpecs(product.measurement_config);
  const dimensions = configuredDimensions ?? [];
  if (configuredDimensions) {
    information.append(textElement('h3', 'product-detail-measure-heading', 'Medidas para cotizar'));
  } else if (product.measurement_config) {
    information.append(textElement('p', 'field-help', 'Las opciones de medidas están pendientes de configuración. Puedes describir tu solicitud abajo.'));
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
  information.append(formDetails);
  productDetailsContent.append(layout);
  productDetailsDialog.showModal();
  productDetailsClose.focus();
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

async function requestEstimate(product, measurements) {
  try {
    const response = await fetch(`/api/catalog/${encodeURIComponent(product.id)}/estimate`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ measurements }),
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (result.status !== 'estimated' || !formatMoney(result.amount, result.currency)) return null;
    return { amount: result.amount, currency: result.currency };
  } catch {
    return null;
  }
}

function addRequest(product, measurements = {}, notes = '') {
  const key = `${product.id}:${++requestSequence}`;
  const item = { key, product, measurements, notes: notes.trim(), estimate: null };
  requests.set(key, item);
  renderRequest();
  return item;
}

function requestSummary() {
  const lines = ['SOLICITUD DE COTIZACIÓN', ''];
  let index = 0;
  for (const item of requests.values()) {
    index += 1;
    lines.push(`Producto ${index}: ${item.product.name}`);
    if (item.product.category_name) lines.push(`Categoría: ${item.product.category_name}`);
    const photos = (item.product.media ?? []).filter((media) => typeof media.url === 'string' && media.url);
    lines.push('Fotografías:');
    if (photos.length) photos.forEach((photo, photoIndex) => lines.push(`- Fotografía ${photoIndex + 1}: ${new URL(photo.url, window.location.origin).href}`));
    else lines.push('- No disponibles públicamente.');
    const videos = item.product.videos?.length ? item.product.videos : (item.product.video ? [item.product.video] : []);
    lines.push('Videos:');
    const publicVideos = videos.filter((video) => typeof video.url === 'string');
    if (publicVideos.length) publicVideos.forEach((video, videoIndex) => {
      const videoUrl = new URL(video.url, window.location.origin).href;
      lines.push(`- Video ${videoIndex + 1}: ${videoUrl}`);
    });
    else lines.push('- No disponibles públicamente.');
    lines.push('Medidas:');
    if (!Object.keys(item.measurements).length) lines.push('- No indicadas.');
    for (const [dimension, value] of Object.entries(item.measurements)) {
      const label = dimensionLabel(item.product, dimension);
      lines.push(`- ${label}: ${formatMeasurement(value, 3)} m (${formatMeasurement(value * 100, 2)} cm)`);
    }
    const fixed = fixedDimensionSpecs(item.product.fixed_dimensions);
    if (fixed.length) lines.push(`Dimensiones registradas: ${fixed.map((dimension) => `${dimension.label}: ${formatMeasurement(dimension.value_m, 3)} m`).join(' · ')}`);
    if (item.product.description?.trim()) lines.push(`Detalles: ${item.product.description.trim()}`);
    if (item.notes) lines.push(`Información adicional: ${item.notes}`);
    lines.push(requestPriceLabel(item.product, item.estimate));
    lines.push('', '--------------------------------', '');
  }
  lines.push('MENSAJE:', 'Me gustaría recibir información y cotización sobre estos trabajos.', '', 'El precio final se acordará directamente con el maestro ebanista, teniendo en cuenta las características y especificaciones de cada mueble.');
  return lines.join('\n');
}

function requestPriceLabel(product, estimate) {
  if (estimate) return `  Estimación orientativa: ${formatMoney(estimate.amount, estimate.currency)}`;
  const publishedPrice = formatMoney(product.price, product.currency);
  return publishedPrice
    ? `  Precio publicado (por confirmar): ${publishedPrice}`
    : '  Precio: por cotizar';
}

function dimensionLabel(product, key) {
  const configured = product.measurement_config?.dimensions?.find((dimension) => dimension.key === key)?.label;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return { width_m: 'Ancho', height_m: 'Alto', depth_m: 'Fondo', length_m: 'Largo', thickness_m: 'Espesor' }[key] ?? 'Otra medida';
}

function renderRequest() {
  requestItemsElement.replaceChildren();

  for (const item of requests.values()) {
    const row = document.createElement('li');
    row.className = 'request-item';
    const photo = item.product.media?.find((media) => typeof media.url === 'string' && media.url);
    const photoFrame = document.createElement('div');
    photoFrame.className = 'request-item-photo';
    if (photo) {
      const image = document.createElement('img');
      image.src = photo.url;
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
    description.append(textElement('strong', '', item.product.name));

    const measurements = Object.entries(item.measurements);
    if (measurements.length) {
      const labels = measurements.map(([key, value]) => {
        const label = dimensionLabel(item.product, key);
        return `${label}: ${formatMeasurement(value, 3)} m`;
      });
      description.append(textElement('span', 'request-item-detail', `Medidas solicitadas: ${labels.join(' · ')}`));
    }

    const modelDimensions = fixedDimensionSpecs(item.product.fixed_dimensions);
    if (modelDimensions.length) {
      const labels = modelDimensions.map((dimension) => `${dimension.label.trim()}: ${formatMeasurement(dimension.value_m, 3)} m`);
      description.append(textElement('span', 'request-item-detail', `Medidas del modelo: ${labels.join(' · ')}`));
    }

    description.append(textElement(
      'span',
      'request-item-detail',
      requestPriceLabel(item.product, item.estimate).trim(),
    ));
    if (item.notes) description.append(textElement('span', 'request-item-detail', `Solicitud adicional: ${item.notes}`));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-text remove-item';
    remove.dataset.removeItem = item.key;
    remove.setAttribute('aria-label', `Quitar ${item.product.name} de la solicitud`);
    remove.textContent = 'Quitar';
    row.append(photoFrame, description, remove);
    requestItemsElement.append(row);
  }

  const count = requests.size;
  requestCount.textContent = String(count);
  requestCount.setAttribute('aria-label', `${count} ${count === 1 ? 'producto' : 'productos'}`);
  requestStatus.textContent = count
    ? `${count} ${count === 1 ? 'trabajo agregado' : 'trabajos agregados'} a la solicitud.`
    : 'Aún no has agregado muebles.';
  requestEmpty.hidden = count > 0;
  requestText.value = count ? requestSummary() : '';
  copyRequestButton.disabled = count === 0;
  clearRequestButton.disabled = count === 0;
}

sendWhatsAppButton.addEventListener('click', () => {
  const message = requestText.value || 'Hola, quisiera cotizar un diseño de mueble. ¿Podrían orientarme?';
  const destination = '573233785300';
  window.location.assign(`https://wa.me/${destination}?text=${encodeURIComponent(message)}`);
});

grid.addEventListener('click', async (event) => {
  const detailsButton = event.target.closest('[data-product-details]');
  if (detailsButton) {
    const product = productsById.get(detailsButton.dataset.productDetails);
    if (product) openProductDetails(product, detailsButton);
    return;
  }

  const button = event.target.closest('[data-quote-product]');
  if (!button) return;

  const product = productsById.get(button.dataset.quoteProduct);
  if (!product) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const originalText = button.textContent;
  button.textContent = 'Preparando solicitud…';
  let item;
  try {
    item = addRequest(product);
  } catch {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    showNotification('No se pudo agregar el mueble a tu solicitud. Inténtalo de nuevo.', { type: 'error' });
    return;
  }
  showNotification('¡Solicitud agregada! Ya puedes revisarla o seguir eligiendo productos', {
    actionLabel: 'Ver mi solicitud',
    actionHref: '#solicitud',
  });
  const estimate = await requestEstimate(product, item.measurements);
  if (estimate && requests.has(item.key)) {
    item.estimate = estimate;
    renderRequest();
  }
  requestStatus.textContent = estimate
    ? `${product.name} se agregó. La estimación es orientativa y debe confirmarse.`
    : `${product.name} se agregó; el precio está pendiente de configuración o confirmación.`;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  button.textContent = originalText;
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
productDetailsDialog.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('.measurement-form')) return;
  event.preventDefault();

  const { measurements, errors } = validateMeasurements(form);
  if (errors.length) {
    errors[0].focus();
    return;
  }

  const product = productsById.get(form.dataset.productId);
  if (!product) return;
  const submitButton = form.querySelector('button[type="submit"]');
  const outcome = form.querySelector('.estimate-outcome');
  const notes = form.querySelector('[name="special_request"]')?.value ?? '';
  submitButton.disabled = true;
  submitButton.setAttribute('aria-busy', 'true');
  submitButton.textContent = 'Agregando…';
  outcome.textContent = 'Agregando el mueble a tu solicitud…';
  let item;
  try {
    item = addRequest(product, measurements, notes);
  } catch {
    submitButton.disabled = false;
    submitButton.removeAttribute('aria-busy');
    submitButton.textContent = 'Solicitar cotización';
    outcome.textContent = 'No se pudo agregar el mueble a tu solicitud. Conservamos la información; inténtalo de nuevo.';
    showNotification('No se pudo agregar el mueble a tu solicitud. Inténtalo de nuevo.', { type: 'error' });
    return;
  }
  productDetailsDialog.close();
  showNotification('¡Solicitud agregada! Ya puedes revisarla o seguir eligiendo productos', {
    actionLabel: 'Ver mi solicitud',
    actionHref: '#solicitud',
  });
  const estimate = await requestEstimate(product, measurements);
  if (estimate && requests.has(item.key)) {
    item.estimate = estimate;
    renderRequest();
  }
  submitButton.disabled = false;
  submitButton.removeAttribute('aria-busy');
  submitButton.textContent = 'Solicitar cotización';
  outcome.textContent = 'El mueble se agregó a Mi solicitud. Revisa el resumen y envíalo por WhatsApp cuando estés listo.';
  requestStatus.textContent = `${product.name} se agregó a Mi solicitud${estimate ? ` con una estimación orientativa de ${formatMoney(estimate.amount, estimate.currency)}` : ''}.`;
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

grid.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('.measurement-form')) return;
  event.preventDefault();

  const { measurements, errors } = validateMeasurements(form);
  if (errors.length) {
    errors[0].focus();
    return;
  }

  const product = productsById.get(form.dataset.productId);
  if (!product) return;

  const outcome = form.querySelector('.estimate-outcome');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.setAttribute('aria-busy', 'true');
  submitButton.textContent = 'Preparando solicitud…';
  outcome.textContent = 'Revisando si hay una regla de precio configurada…';
  let item;
  try {
    item = addRequest(product, measurements);
  } catch {
    submitButton.disabled = false;
    submitButton.removeAttribute('aria-busy');
    submitButton.textContent = 'Solicitar cotización';
    outcome.textContent = 'No se pudo agregar el mueble a tu solicitud. Conservamos la información; inténtalo de nuevo.';
    showNotification('No se pudo agregar el mueble a tu solicitud. Inténtalo de nuevo.', { type: 'error' });
    return;
  }
  showNotification('¡Solicitud agregada! Ya puedes revisarla o seguir eligiendo productos', {
    actionLabel: 'Ver mi solicitud',
    actionHref: '#solicitud',
  });
  const estimate = await requestEstimate(product, measurements);
  if (estimate && requests.has(item.key)) {
    item.estimate = estimate;
    renderRequest();
  }
  outcome.textContent = estimate
    ? `Estimación orientativa: ${formatMoney(estimate.amount, estimate.currency)}. El precio final se acordará directamente con el maestro ebanista, teniendo en cuenta las características y especificaciones del mueble.`
    : 'Precio pendiente de configuración. Puedes agregar el trabajo para solicitar una cotización.';
  requestStatus.textContent = estimate
    ? `${product.name} con las medidas indicadas se agregó. La estimación debe confirmarse.`
    : `${product.name} se agregó; el precio está pendiente de configuración o confirmación.`;
  submitButton.disabled = false;
  submitButton.removeAttribute('aria-busy');
  submitButton.textContent = 'Solicitar cotización';
});

requestItemsElement.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-item]');
  if (!button) return;
  requests.delete(button.dataset.removeItem);
  renderRequest();
});

clearRequestButton.addEventListener('click', () => {
  requests.clear();
  renderRequest();
});

copyRequestButton.addEventListener('click', async () => {
  if (!requestText.value) return;
  try {
    await navigator.clipboard.writeText(requestText.value);
    requestStatus.textContent = 'Solicitud copiada. Ya puedes compartirla con el carpintero.';
  } catch {
    requestText.focus();
    requestText.select();
    requestStatus.textContent = 'El texto quedó seleccionado. Cópialo para compartir la solicitud.';
  }
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
    if (selectedCategory && !catalogProducts.some((product) => product.category_slug === selectedCategory)) {
      selectedCategory = '';
    }
    grid.setAttribute('aria-busy', 'false');
    if (!result.products.length) {
      catalogStatus.textContent = 'Todavía no hay muebles publicados.';
      categoryFilters.hidden = true;
      categoryFilters.replaceChildren();
      grid.replaceChildren(textElement('p', 'catalog-empty', 'Aún no hay muebles publicados. Cuando haya modelos disponibles, podrás explorar aquí sus fotografías, medidas y precios.'));
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
