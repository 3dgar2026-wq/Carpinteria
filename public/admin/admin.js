import { showNotification } from '../notifications.js';

const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
const statusElement = document.querySelector('#admin-status');
const categoryForm = document.querySelector('#category-form');
const productForm = document.querySelector('#product-form');
const categoryList = document.querySelector('#category-list');
const productList = document.querySelector('#product-list');
const productSearchInput = document.querySelector('#product-search');
const productStatusFilter = document.querySelector('#product-status-filter');
const productListStatus = document.querySelector('#product-list-status');
const productEditor = document.querySelector('#product-editor');
const productsEmptyHelp = document.querySelector('#products-empty-help');
const productDeleteDialog = document.querySelector('#product-delete-dialog');
const productDeleteImage = document.querySelector('#product-delete-image');
const productDeleteImagePlaceholder = document.querySelector('#product-delete-image-placeholder');
const productDeleteName = document.querySelector('#product-delete-name');
const productDeleteDescription = document.querySelector('#product-delete-description');
const productDeleteId = document.querySelector('#product-delete-id');
const cancelProductDeleteButton = document.querySelector('#cancel-product-delete');
const confirmProductDeleteButton = document.querySelector('#confirm-product-delete');
const photoSelectionList = document.querySelector('#photo-selection-list');
const photoInboxStatus = document.querySelector('#photo-inbox-status');
const photoUploadStatus = document.querySelector('#photo-upload-status');
const photoPendingGrid = document.querySelector('#photo-pending-grid');
const adminViewElements = [...document.querySelectorAll('[data-admin-view]')];
const adminNavigationLinks = [...document.querySelectorAll('.admin-nav-link[href^="#"]')];
const selectedPhotoFiles = [];
const wizardPhotoFiles = [];
let categorySlugEdited = false;
let productSlugEdited = false;
let currentWizardStep = 1;
let editingProduct = null;
let categoriesById = new Map();
let currentCategories = [];
let currentProducts = null;
let pendingProductDeletion = null;
let productDeleteTrigger = null;
let productMeasurementsTouched = false;
let selectedProductCategoryId = '';
let fixedDimensionsFormatUnknown = false;
let photoPage = 1;
let photoPageCount = 0;
let imageLibraryPage = 1;
let imageLibraryPageCount = 0;
let imageLibrarySearchTerm = '';
let photoMaxBatchFiles = 100;
let photoMaxFileBytes = 5 * 1024 * 1024;
let wizardMaxVideoFileBytes = 50 * 1024 * 1024;
let photoUploadInProgress = false;
let photoUploadBatchId = null;
let preferredPhotoProductId = '';
let wizardPendingPhoto = null;
let wizardPhotoUploadInProgress = false;
let wizardSaveInProgress = false;
let wizardExistingMedia = [];
let wizardExistingVideos = [];
let wizardSelectedVideos = [];
let wizardRemovedVideoIds = new Set();
const wizardVideoPreviewUrls = new Map();
let wizardMediaOrder = [];
let wizardCoverKey = null;
let wizardGalleryDirty = false;
let quickCreateCategoryRequested = false;
let photoSearchTerm = '';
const maximumMeasurementCount = 12;
const measurementKinds = new Map([
  ['width_m', 'Ancho'],
  ['height_m', 'Alto'],
  ['length_m', 'Largo'],
  ['depth_m', 'Fondo o profundidad'],
  ['thickness_m', 'Espesor'],
]);

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.dataset.state = isError ? 'error' : 'success';
}

function resolveAdminView(target) {
  const normalized = target === 'product-editor' ? 'products-section' : target;
  return adminViewElements.some((view) => view.dataset.adminView === normalized)
    ? normalized
    : 'products-section';
}

function renderAdminView(target, { focus = false } = {}) {
  const activeView = resolveAdminView(target);
  for (const view of adminViewElements) view.hidden = view.dataset.adminView !== activeView;
  for (const link of adminNavigationLinks) {
    const isActive = link.hash.slice(1) === activeView;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (activeView === 'category-management') document.querySelector('#category-management').open = true;
  if (focus) {
    const heading = {
      'products-section': '#products-title',
      'photo-inbox': '#photo-inbox-title',
      'photo-upload-section': '#photo-upload-title',
      'category-management': '#category-management > summary',
    }[activeView];
    document.querySelector(heading)?.focus();
  }
  return activeView;
}

function navigateAdminView(target, { replace = false, focus = false } = {}) {
  const activeView = resolveAdminView(target);
  const hash = `#${activeView}`;
  if (window.location.hash !== hash) {
    const method = replace ? 'replaceState' : 'pushState';
    window.history[method](null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }
  renderAdminView(activeView, { focus });
}

function syncAdminViewFromLocation() {
  const requested = window.location.hash.slice(1);
  const activeView = resolveAdminView(requested || 'products-section');
  if (requested === 'product-editor') {
    productEditor.hidden = false;
    productForm.hidden = false;
    document.querySelector('#product-save-result').hidden = true;
  }
  if (window.location.hash !== `#${activeView}`) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${activeView}`);
  }
  renderAdminView(activeView);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-Token': csrfToken,
      ...options.headers,
    },
  });
  if (response.status === 401) {
    window.location.assign('/admin/login');
    throw new Error('La sesión terminó. Inicia sesión nuevamente.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'No se pudo completar la operación.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(label, className, onClick) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function openProductDeleteDialog(product, trigger = document.activeElement) {
  pendingProductDeletion = product;
  productDeleteTrigger = trigger instanceof HTMLElement ? trigger : null;
  productDeleteName.textContent = product.name;
  productDeleteDescription.textContent = product.description ?? '';
  productDeleteDescription.hidden = !product.description;
  productDeleteId.textContent = String(product.id);

  const cover = (product.media ?? []).find((media) => media.kind === 'image' && media.isCover)
    ?? (product.media ?? []).find((media) => media.kind === 'image');
  if (cover?.adminUrl) {
    productDeleteImage.alt = cover.altText || `Fotografía principal de ${product.name}`;
    productDeleteImage.hidden = false;
    productDeleteImagePlaceholder.hidden = true;
    productDeleteImage.onerror = () => {
      productDeleteImage.hidden = true;
      productDeleteImagePlaceholder.hidden = false;
    };
    productDeleteImage.src = cover.adminUrl;
  } else {
    productDeleteImage.removeAttribute('src');
    productDeleteImage.alt = '';
    productDeleteImage.hidden = true;
    productDeleteImagePlaceholder.hidden = false;
  }

  productDeleteDialog.showModal();
  cancelProductDeleteButton.focus();
}

cancelProductDeleteButton.addEventListener('click', () => productDeleteDialog.close());
productDeleteDialog.addEventListener('close', () => {
  pendingProductDeletion = null;
  if (productDeleteTrigger?.isConnected) productDeleteTrigger.focus();
  productDeleteTrigger = null;
});
confirmProductDeleteButton.addEventListener('click', () => {
  const product = pendingProductDeletion;
  if (!product) return;
  productDeleteDialog.close();
  void performProductDeletion(product);
});

function toSlug(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseDecimal(value, label, allowEmpty = false) {
  const normalized = value.trim().replace(',', '.');
  if (!normalized && allowEmpty) return null;
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
    throw new Error(`${label}: escribe un número decimal válido usando metros.`);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`${label}: el valor debe ser finito.`);
  return number;
}

function collectMeasurementConfig(containerId) {
  const container = document.querySelector(`#${containerId}`);
  const dimensions = [];
  const keys = new Set();
  for (const row of container.querySelectorAll('.measurement-card')) {
    const key = row.dataset.key;
    const label = row.querySelector('.dimension-label').value.trim();
    const min = parseDecimal(row.querySelector('.dimension-min').value, `Límite mínimo de ${label || 'la medida'}`, true);
    const max = parseDecimal(row.querySelector('.dimension-max').value, `Límite máximo de ${label || 'la medida'}`, true);
    const help = row.querySelector('.dimension-help').value.trim();
    if (!label) throw new Error('Escribe un nombre para cada medida agregada.');
    if (keys.has(key)) throw new Error('Hay dos medidas con la misma referencia. Quita una de ellas y vuelve a intentarlo.');
    keys.add(key);
    if ((min !== null && min < 0) || (max !== null && max < 0)) {
      throw new Error(`Los límites de “${label}” no pueden ser negativos.`);
    }
    if (min !== null && max !== null && min > max) {
      throw new Error(`En “${label}”, el mínimo no puede ser mayor que el máximo.`);
    }
    if (dimensions.length >= maximumMeasurementCount) {
      throw new Error(`Puedes agregar hasta ${maximumMeasurementCount} medidas por plantilla o producto.`);
    }
    const dimension = {
      key,
      label,
      help,
      required: row.querySelector('.dimension-required').checked,
    };
    if (min !== null) dimension.min_m = min;
    if (max !== null) dimension.max_m = max;
    dimensions.push(dimension);
  }
  return dimensions.length ? { version: 1, dimensions } : null;
}

function newDimensionKey(kind) {
  if (kind !== 'custom') return kind;
  return `custom_${crypto.randomUUID().replaceAll('-', '')}`;
}

function dimensionCountMessage(config) {
  const count = config?.dimensions?.length ?? 0;
  return `${count} ${count === 1 ? 'medida' : 'medidas'}`;
}

function inspectFixedDimensions(value) {
  if (value === null || value === undefined) return { recognized: true, config: null };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !Array.isArray(value.dimensions) || value.dimensions.length < 1
    || value.dimensions.length > maximumMeasurementCount) {
    return { recognized: false, config: null };
  }
  const valid = value.dimensions.every((dimension) => dimension
    && typeof dimension === 'object' && !Array.isArray(dimension)
    && typeof dimension.label === 'string' && dimension.label.trim().length > 0
    && dimension.label.trim().length <= 60
    && typeof dimension.value_m === 'number' && Number.isFinite(dimension.value_m)
    && dimension.value_m >= 0);
  return valid
    ? { recognized: true, config: { version: 1, dimensions: value.dimensions.map(({ label, value_m }) => ({ label: label.trim(), value_m })) } }
    : { recognized: false, config: null };
}

function renderMeasurementEditor(containerId, config, onChange) {
  const container = document.querySelector(`#${containerId}`);
  container.replaceChildren();
  const dimensions = config?.dimensions ?? [];
  const isProductEditor = containerId === 'product-dimensions';
  dimensions.forEach((dimension, index) => {
    const card = element('div', 'dimension-config-row measurement-card');
    card.dataset.key = dimension.key;

    const heading = element('div', 'measurement-card-heading');
    const title = element('strong', '', dimension.label || (isProductEditor ? 'Medida nueva' : 'Medida personalizada'));
    const actions = element('div', 'measurement-card-actions');
    const up = makeButton('Subir', 'button button-text', () => moveMeasurement(containerId, index, -1, onChange));
    const down = makeButton('Bajar', 'button button-text', () => moveMeasurement(containerId, index, 1, onChange));
    const remove = makeButton('Quitar', 'button button-text', () => {
      card.remove();
      refreshMeasurementOrder(containerId, onChange);
      onChange?.();
    });
    up.setAttribute('aria-label', `Mover “${dimension.label || 'medida personalizada'}” arriba`);
    down.setAttribute('aria-label', `Mover “${dimension.label || 'medida personalizada'}” abajo`);
    remove.setAttribute('aria-label', `Quitar “${dimension.label || 'medida personalizada'}”`);
    up.disabled = index === 0;
    down.disabled = index === dimensions.length - 1;
    actions.append(remove);
    if (!isProductEditor) actions.prepend(up, down);
    if (isProductEditor) heading.append(actions);
    else heading.append(title, actions);

    const nameLabel = element('label', 'field-label', 'Nombre que verá el cliente');
    const nameInput = document.createElement('input');
    nameInput.className = 'dimension-label';
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.required = true;
    nameInput.value = dimension.label ?? '';
    nameLabel.append(nameInput);

    const range = element('div', 'dimension-range');
    const minLabel = element('label', 'field-label', 'Desde (m): límite mínimo, si aplica');
    const minInput = document.createElement('input');
    minInput.className = 'dimension-min';
    minInput.type = 'text';
    minInput.inputMode = 'decimal';
    minInput.placeholder = 'Ej. 0,50';
    minInput.value = dimension.min_m === undefined || dimension.min_m === null ? '' : String(dimension.min_m);
    minLabel.append(minInput);
    const maxLabel = element('label', 'field-label', 'Hasta (m): límite máximo, si aplica');
    const maxInput = document.createElement('input');
    maxInput.className = 'dimension-max';
    maxInput.type = 'text';
    maxInput.inputMode = 'decimal';
    maxInput.placeholder = 'Ej. 3,00';
    maxInput.value = dimension.max_m === undefined || dimension.max_m === null ? '' : String(dimension.max_m);
    maxLabel.append(maxInput);
    range.append(minLabel, maxLabel);

    const helpLabel = element('label', 'field-label', 'Explicación para el cliente (opcional)');
    const helpInput = document.createElement('input');
    helpInput.className = 'dimension-help';
    helpInput.type = 'text';
    helpInput.maxLength = 300;
    helpInput.value = dimension.help ?? '';
    helpInput.placeholder = 'Por ejemplo, desde una pared hasta la otra';
    helpLabel.append(helpInput);

    const requiredLabel = element('label', 'check-field');
    const requiredInput = document.createElement('input');
    requiredInput.className = 'dimension-required';
    requiredInput.type = 'checkbox';
    requiredInput.checked = dimension.required !== false;
    requiredLabel.append(requiredInput, document.createTextNode(' El cliente debe indicar esta medida'));

    const update = () => {
      onChange?.();
      if (containerId === 'product-dimensions') updateMeasurementPreview();
    };
    nameInput.addEventListener('input', () => { title.textContent = nameInput.value || (isProductEditor ? 'Medida nueva' : 'Medida personalizada'); update(); });
    minInput.addEventListener('input', update);
    maxInput.addEventListener('input', update);
    helpInput.addEventListener('input', update);
    requiredInput.addEventListener('change', update);

    if (isProductEditor) {
      requiredLabel.replaceChildren(requiredInput, document.createTextNode(' Obligatoria'));
      const advanced = element('details', 'advanced-settings measurement-advanced-settings');
      advanced.append(element('summary', '', 'Opciones avanzadas de medidas'));
      const advancedContent = element('div', 'measurement-advanced-content');
      const orderActions = element('div', 'measurement-card-actions');
      orderActions.append(up, down);
      advancedContent.append(range, helpLabel, orderActions);
      advanced.append(advancedContent);
      card.classList.add('product-measurement-row');
      card.append(heading, nameLabel, requiredLabel, advanced);
    } else {
      card.append(heading, nameLabel, range, helpLabel, requiredLabel);
    }
    container.append(card);
  });
  if (!dimensions.length) {
    const emptyMessage = containerId === 'category-template-dimensions'
      ? 'Esta categoría aún no tiene una plantilla de medidas.'
      : 'Todavía no agregas medidas. Puedes comenzar con una plantilla o crear una propia.';
    container.append(element('p', 'measurement-empty', emptyMessage));
  }
  if (containerId === 'product-dimensions') updateMeasurementPreview();
}

function readFixedDimensionRows() {
  return [...document.querySelector('#fixed-dimensions').querySelectorAll('.fixed-dimension-card')].map((row) => ({
    label: row.querySelector('.fixed-dimension-label').value,
    value_m: row.querySelector('.fixed-dimension-value').value,
  }));
}

function collectFixedDimensions() {
  const dimensions = readFixedDimensionRows().map((dimension) => {
    const label = dimension.label.trim();
    if (!label) throw new Error('Escribe un nombre para cada dimensión fija.');
    const value = parseDecimal(dimension.value_m, `Valor de ${label}`);
    if (value < 0) throw new Error(`El valor fijo de “${label}” no puede ser negativo.`);
    return { label, value_m: value };
  });
  if (dimensions.length > maximumMeasurementCount) {
    throw new Error(`Puedes agregar hasta ${maximumMeasurementCount} dimensiones fijas.`);
  }
  return dimensions.length ? { version: 1, dimensions } : null;
}

function renderFixedDimensionEditor(config, locked = false) {
  const container = document.querySelector('#fixed-dimensions');
  container.replaceChildren();
  if (locked) {
    container.append(element('p', 'measurement-empty', 'La información anterior se conserva, pero no está disponible en esta vista previa.'));
    return;
  }
  for (const [index, dimension] of (config?.dimensions ?? []).entries()) {
    const card = element('div', 'dimension-config-row measurement-card fixed-dimension-card product-fixed-dimension-row');
    const heading = element('div', 'measurement-card-heading');
    const actions = element('div', 'measurement-card-actions');
    const rows = config.dimensions;
    const move = (offset) => {
      const dimensions = readFixedDimensionRows();
      const destination = index + offset;
      if (destination < 0 || destination >= dimensions.length) return;
      [dimensions[index], dimensions[destination]] = [dimensions[destination], dimensions[index]];
      renderFixedDimensionEditor({ version: 1, dimensions });
      updateMeasurementPreview();
    };
    const up = makeButton('Subir', 'button button-text', () => move(-1));
    const down = makeButton('Bajar', 'button button-text', () => move(1));
    const remove = makeButton('Quitar', 'button button-text', () => {
      card.remove();
      renderFixedDimensionEditor({ version: 1, dimensions: readFixedDimensionRows() });
      updateMeasurementPreview();
    });
    up.disabled = index === 0;
    down.disabled = index === rows.length - 1;
    up.setAttribute('aria-label', `Subir ${dimension.label || 'dimensión fija'}`);
    down.setAttribute('aria-label', `Bajar ${dimension.label || 'dimensión fija'}`);
    remove.setAttribute('aria-label', `Quitar ${dimension.label || 'dimensión fija'}`);
    actions.append(up, down, remove);
    heading.append(actions);

    const label = element('label', 'field-label', 'Nombre de la dimensión');
    const nameInput = document.createElement('input');
    nameInput.className = 'fixed-dimension-label';
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.required = true;
    nameInput.value = dimension.label ?? '';
    label.append(nameInput);

    const valueLabel = element('label', 'field-label', 'Valor en metros (m)');
    const valueInput = document.createElement('input');
    valueInput.className = 'fixed-dimension-value';
    valueInput.type = 'text';
    valueInput.inputMode = 'decimal';
    valueInput.placeholder = 'Ej. 2,00';
    valueInput.value = dimension.value_m === undefined || dimension.value_m === null ? '' : String(dimension.value_m);
    valueLabel.append(valueInput);
    nameInput.addEventListener('input', updateMeasurementPreview);
    valueInput.addEventListener('input', updateMeasurementPreview);
    card.append(heading, label, valueLabel);
    container.append(card);
  }
  if (!config?.dimensions?.length) {
    container.append(element('p', 'measurement-empty', 'No hay dimensiones fijas configuradas para mostrar.'));
  }
}

function updateMeasurementPreview() {
  const preview = document.querySelector('#measurement-preview');
  if (!preview) return;
  preview.replaceChildren();
  const customerDimensions = readMeasurementRows('product-dimensions');
  const fixedDimensions = readFixedDimensionRows();

  const customerSection = element('section', 'preview-group');
  customerSection.append(element('h5', '', 'Medidas que debes proporcionar'));
  if (!customerDimensions.length) {
    customerSection.append(element('p', 'measurement-empty', 'No se solicitarán medidas.'));
  } else {
    for (const dimension of customerDimensions) {
      customerSection.append(element('p', 'preview-fixed-dimension', `${dimension.label.trim() || 'Nombre de la medida'} (m)`));
    }
  }

  const fixedSection = element('section', 'preview-group');
  fixedSection.append(element('h5', '', 'Dimensiones del mueble'));
  if (!fixedDimensions.length) {
    fixedSection.append(element('p', 'measurement-empty', fixedDimensionsFormatUnknown
      ? 'Hay información anterior que se conservará, pero no puede mostrarse en esta vista previa.'
      : 'No hay dimensiones fijas configuradas.'));
  } else {
    for (const dimension of fixedDimensions) {
      let formattedValue = dimension.value_m;
      try {
        formattedValue = `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(parseDecimal(dimension.value_m, 'Medida'))} m`;
      } catch {
        formattedValue = 'Revisa el valor en metros';
      }
      const row = element('p', 'preview-fixed-dimension');
      row.append(element('strong', '', dimension.label.trim() || 'Dimensión fija'), document.createTextNode(` · ${formattedValue}`));
      fixedSection.append(row);
    }
  }
  preview.append(customerSection, fixedSection);
}

function readMeasurementRows(containerId) {
  return [...document.querySelector(`#${containerId}`).querySelectorAll('.measurement-card')].map((row) => ({
    key: row.dataset.key,
    label: row.querySelector('.dimension-label').value,
    help: row.querySelector('.dimension-help').value,
    min_m: row.querySelector('.dimension-min').value,
    max_m: row.querySelector('.dimension-max').value,
    required: row.querySelector('.dimension-required').checked,
  }));
}

function moveMeasurement(containerId, index, offset, onChange) {
  const container = document.querySelector(`#${containerId}`);
  const cards = [...container.querySelectorAll('.measurement-card')];
  const destination = index + offset;
  if (destination < 0 || destination >= cards.length) return;
  if (offset < 0) container.insertBefore(cards[index], cards[destination]);
  else container.insertBefore(cards[destination], cards[index]);
  refreshMeasurementOrder(containerId);
  onChange?.();
}

function refreshMeasurementOrder(containerId, onChange) {
  const dimensions = readMeasurementRows(containerId);
  renderMeasurementEditor(containerId, { version: 1, dimensions }, onChange);
}

function addMeasurement(containerId, kind, onChange) {
  const existing = readMeasurementRows(containerId);
  if (existing.length >= maximumMeasurementCount) {
    setStatus(`Puedes agregar hasta ${maximumMeasurementCount} medidas.`, true);
    return;
  }
  const key = newDimensionKey(kind);
  if (existing.some((dimension) => dimension.key === key)) {
    setStatus(`“${measurementKinds.get(kind)}” ya está agregada. Puedes editar su nombre o quitarla.`, true);
    return;
  }
  const label = kind === 'custom' ? '' : measurementKinds.get(kind);
  renderMeasurementEditor(containerId, {
    version: 1,
    dimensions: [...existing, { key, label, help: '', required: false }],
  }, onChange);
  container.querySelector('.measurement-card:last-child .dimension-label')?.focus();
  onChange?.();
}

function addFixedDimension() {
  const dimensions = readFixedDimensionRows();
  if (dimensions.length >= maximumMeasurementCount) {
    setStatus(`Puedes agregar hasta ${maximumMeasurementCount} dimensiones fijas.`, true);
    return;
  }
  renderFixedDimensionEditor({
    version: 1,
    dimensions: [...dimensions, { label: '', value_m: '' }],
  });
  document.querySelector('#fixed-dimensions .fixed-dimension-card:last-child .fixed-dimension-label')?.focus();
  updateMeasurementPreview();
}

function setWizardStep(step) {
  currentWizardStep = Math.min(5, Math.max(1, step));
  for (const section of productForm.querySelectorAll('.wizard-step')) {
    section.hidden = Number(section.dataset.wizardStep) !== currentWizardStep;
  }
  for (const item of productForm.querySelectorAll('[data-progress-step]')) {
    const number = Number(item.dataset.progressStep);
    if (number === currentWizardStep) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    item.classList.toggle('is-complete', number < currentWizardStep);
  }
  document.querySelector('#wizard-previous').hidden = currentWizardStep === 1;
  document.querySelector('#wizard-next').hidden = currentWizardStep === 5;
  updateWizardCategorySelection();
  if (currentWizardStep === 5) renderProductReview();
  productForm.querySelector(`[data-wizard-step="${currentWizardStep}"] h3`)?.focus();
}

function renderProductReview() {
  const review = document.querySelector('#product-review');
  const categorySelect = document.querySelector('#product-category');
  const dimensions = collectMeasurementConfig('product-dimensions')?.dimensions ?? [];
  const selectedCategory = categoriesById.get(categorySelect.value);
  const fixedDimensions = readFixedDimensionRows();
  const retainedMedia = wizardExistingMedia.filter((media) => media.keep);
  const uploadedMedia = wizardPhotoFiles.filter((entry) => entry.media);
  const chosenCover = resolveWizardCover();
  const rows = [
    ['Producto', document.querySelector('#product-name').value.trim() || 'Falta el nombre'],
    ['Categoría', selectedCategory?.name || 'Falta elegir una categoría'],
    ['Descripción', document.querySelector('#product-description').value.trim() || 'Sin descripción'],
    ['Fotografías', `${retainedMedia.length + uploadedMedia.length + Number(Boolean(wizardPendingPhoto))} seleccionadas${chosenCover ? ' · portada elegida' : ''}`],
    ['Videos', `${wizardExistingVideos.length - wizardRemovedVideoIds.size} guardados · ${wizardSelectedVideos.length} nuevos`],
    ['Medidas para cotizar', dimensions.length ? dimensions.map((dimension) => dimension.label).join(', ') : 'No se solicitarán medidas'],
    ['Dimensiones fijas', fixedDimensions.length
      ? fixedDimensions.map((dimension) => `${dimension.label}: ${dimension.value_m} m`).join(', ')
      : fixedDimensionsFormatUnknown ? 'Se conservará la información anterior sin cambios' : 'No se mostrarán dimensiones fijas'],
  ];
  review.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = element('dt', '', label);
    const description = element('dd', '', value);
    return [term, description];
  }));
}

function showProductEditor() {
  navigateAdminView('products-section');
  productEditor.hidden = false;
  productForm.hidden = false;
  document.querySelector('#product-save-result').hidden = true;
  setWizardStep(1);
  productEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderWizardMedia(product) {
  const preview = document.querySelector('#wizard-media-preview');
  for (const url of wizardVideoPreviewUrls.values()) URL.revokeObjectURL(url);
  wizardVideoPreviewUrls.clear();
  const savedMedia = product?.media ?? [];
  wizardExistingMedia = savedMedia.filter((media) => media.kind === 'image').map((media) => ({ ...media, keep: true }));
  wizardExistingVideos = savedMedia.filter((media) => media.kind === 'video');
  wizardSelectedVideos = [];
  wizardRemovedVideoIds = new Set();
  wizardMediaOrder = wizardExistingMedia.map((media) => `media:${media.id}`);
  wizardCoverKey = wizardExistingMedia.find((media) => media.isCover)
    ? `media:${wizardExistingMedia.find((media) => media.isCover).id}`
    : null;
  if (wizardPendingPhoto) wizardMediaOrder.push(`pending:${wizardPendingPhoto.id}`);
  wizardGalleryDirty = false;
  preview.replaceChildren();
  if (!wizardExistingMedia.length && !wizardPendingPhoto) {
    preview.append(element('p', 'field-help', 'Este mueble todavía no tiene fotografías asociadas.'));
  } else {
    preview.append(element('p', 'field-help', 'Las fotos guardadas pertenecen a este mueble. Si quitas una, dejará de pertenecerle y no volverá a pendientes.'));
    const grid = element('div', 'wizard-gallery-grid');
    for (const media of wizardExistingMedia) {
      const card = element('div', 'wizard-gallery-card');
      if (media.kind === 'image' && media.adminUrl) {
        const image = element('img');
        image.src = media.adminUrl;
        image.alt = media.altText || 'Fotografía asociada al mueble';
        image.loading = 'lazy';
        card.append(image);
      }
      const keepLabel = element('label');
      const keep = document.createElement('input');
      keep.type = 'checkbox';
      keep.checked = true;
      keep.addEventListener('change', () => {
        media.keep = keep.checked;
        if (!media.keep && wizardCoverKey === `media:${media.id}`) wizardCoverKey = null;
        wizardGalleryDirty = true;
        renderWizardPhotoOptions();
        if (currentWizardStep === 5) renderProductReview();
      });
      keepLabel.append(keep, document.createTextNode('Conservar en este mueble'));
      card.append(keepLabel, element('span', 'field-help', media.isPublic === false ? 'Oculta en la tienda' : 'Visible si el mueble está publicado'));
      grid.append(card);
    }
    if (wizardPendingPhoto) {
      const card = element('div', 'wizard-gallery-card');
      const image = element('img');
      image.src = wizardPendingPhoto.adminUrl;
      image.alt = `Fotografía pendiente: ${wizardPendingPhoto.original_filename}`;
      image.loading = 'lazy';
      const info = element('span', 'field-help', `Pendiente · ${wizardPendingPhoto.original_filename}`);
      const remove = makeButton('Quitar de este mueble', 'button button-text', () => {
        wizardPendingPhoto = null;
        wizardMediaOrder = wizardMediaOrder.filter((key) => !key.startsWith('pending:'));
        wizardGalleryDirty = true;
        renderWizardMedia(null);
        if (currentWizardStep === 5) renderProductReview();
      });
      card.append(image, info, remove);
      grid.append(card);
    }
    preview.append(grid);
  }
  renderWizardPhotoOptions();
  renderWizardVideo();
}

function renderWizardVideo() {
  const preview = document.querySelector('#wizard-video-preview');
  preview.replaceChildren();
  for (const media of wizardExistingVideos) {
    const card = element('div', 'wizard-video-item');
    const player = element('video', 'wizard-video-player');
    player.controls = true;
    player.preload = 'none';
    player.muted = true;
    player.src = media.adminUrl;
    const remove = makeButton(
      wizardRemovedVideoIds.has(String(media.id)) ? 'Conservar video' : 'Quitar este video',
      'button button-text',
      () => {
        const id = String(media.id);
        if (wizardRemovedVideoIds.has(id)) wizardRemovedVideoIds.delete(id);
        else wizardRemovedVideoIds.add(id);
        renderWizardVideo();
        if (currentWizardStep === 5) renderProductReview();
      },
    );
    card.append(player, element('p', 'field-help', `${media.originalFilename || 'Video guardado'} · asociado a este trabajo.`), remove);
    if (wizardRemovedVideoIds.has(String(media.id))) card.classList.add('is-marked-for-removal');
    preview.append(card);
  }
  for (const file of wizardSelectedVideos) {
    const card = element('div', 'wizard-video-item');
    const player = element('video', 'wizard-video-player');
    player.controls = true;
    player.preload = 'metadata';
    player.muted = true;
    if (!wizardVideoPreviewUrls.has(file)) wizardVideoPreviewUrls.set(file, URL.createObjectURL(file));
    player.src = wizardVideoPreviewUrls.get(file);
    const remove = makeButton('Quitar video seleccionado', 'button button-text', () => {
      const url = wizardVideoPreviewUrls.get(file);
      if (url) URL.revokeObjectURL(url);
      wizardVideoPreviewUrls.delete(file);
      wizardSelectedVideos = wizardSelectedVideos.filter((selected) => selected !== file);
      renderWizardVideo();
      if (currentWizardStep === 5) renderProductReview();
    });
    card.append(player, element('p', 'field-help', `${file.name} · se agregará al guardar el trabajo.`), remove);
    preview.append(card);
  }
  if (!wizardExistingVideos.length && !wizardSelectedVideos.length) {
    preview.append(element('p', 'field-help', 'Este trabajo todavía no tiene videos asociados.'));
  }
  const input = document.querySelector('#wizard-video-file');
  input.disabled = false;
}

function formatMediaSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function validateWizardVideoFile(file) {
  if (!(file instanceof File)) return 'Selecciona un video válido.';
  const extension = file.name.toLowerCase().split('.').pop();
  const allowed = (file.type === 'video/mp4' && extension === 'mp4')
    || (file.type === 'video/webm' && extension === 'webm')
    || (!file.type && ['mp4', 'webm'].includes(extension));
  if (!allowed) return 'Usa un archivo MP4 o WebM válido.';
  if (file.size === 0 || file.size > wizardMaxVideoFileBytes) {
    return `El video debe tener entre 1 byte y ${formatMediaSize(wizardMaxVideoFileBytes)}.`;
  }
  return '';
}

async function saveWizardVideo(productId) {
  const status = document.querySelector('#wizard-video-status');
  for (const file of [...wizardSelectedVideos]) {
    const error = validateWizardVideoFile(file);
    if (error) throw new Error(error);
    status.textContent = `Subiendo ${file.name}…`;
    status.dataset.state = 'loading';
    let result;
    try {
      result = await api(`/api/admin/products/${encodeURIComponent(String(productId))}/videos`, {
        method: 'POST',
        body: file,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Original-Filename': encodeURIComponent(file.name),
        },
      });
    } catch (error) {
      status.textContent = error.message;
      status.dataset.state = 'error';
      throw error;
    }
    const previewUrl = wizardVideoPreviewUrls.get(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    wizardVideoPreviewUrls.delete(file);
    wizardExistingVideos.push({
      id: result.video.id,
      kind: 'video',
      adminUrl: `/api/admin/products/${encodeURIComponent(String(productId))}/videos/${encodeURIComponent(String(result.video.id))}/content`,
      originalFilename: file.name,
    });
    wizardSelectedVideos = wizardSelectedVideos.filter((selected) => selected !== file);
    status.textContent = result.message || 'Video agregado al trabajo.';
    status.dataset.state = 'success';
  }
  for (const mediaId of [...wizardRemovedVideoIds]) {
    status.textContent = 'Quitando video…';
    status.dataset.state = 'loading';
    let result;
    try {
      result = await api(`/api/admin/products/${encodeURIComponent(String(productId))}/videos/${encodeURIComponent(mediaId)}`, {
        method: 'DELETE',
        body: '{}',
      });
    } catch (error) {
      status.textContent = error.message;
      status.dataset.state = 'error';
      throw error;
    }
    wizardExistingVideos = wizardExistingVideos.filter((media) => String(media.id) !== mediaId);
    wizardRemovedVideoIds.delete(mediaId);
    status.textContent = result.message || 'Video retirado del trabajo.';
    status.dataset.state = 'success';
  }
  renderWizardVideo();
}

function resolveWizardCover() {
  if (wizardCoverKey?.startsWith('media:')) return wizardCoverKey.slice('media:'.length);
  if (wizardCoverKey?.startsWith('pending:')) return wizardPendingPhoto?.id ?? null;
  if (wizardCoverKey?.startsWith('file:')) {
    const entry = wizardPhotoFiles.find((candidate) => `file:${candidate.id}` === wizardCoverKey);
    return entry?.media?.id ? String(entry.media.id) : null;
  }
  return null;
}

function setWizardCover(key) {
  wizardCoverKey = key;
  wizardGalleryDirty = true;
  renderWizardPhotoOptions();
  if (currentWizardStep === 5) renderProductReview();
}

function renderWizardPhotoOptions() {
  const selectedList = document.querySelector('#wizard-selected-photos');
  const coverOptions = document.querySelector('#wizard-cover-options');
  if (!selectedList || !coverOptions) return;
  selectedList.replaceChildren();
  coverOptions.replaceChildren();

  for (const entry of wizardPhotoFiles) {
    const item = element('li', 'photo-selection-item');
    const sizeRejected = entry.file.size === 0 || entry.file.size > photoMaxFileBytes;
    if (entry.formatRejected || sizeRejected || entry.previewError) {
      const reason = entry.formatRejected
        ? 'Formato no admitido'
        : sizeRejected ? 'Archivo fuera del límite' : 'Vista previa no disponible';
      item.append(element('div', 'photo-selection-thumb photo-selection-invalid', reason));
    } else {
      const image = element('img', 'photo-selection-thumb');
      image.alt = '';
      if (entry.previewDataUrl) image.src = entry.previewDataUrl;
      image.addEventListener('error', () => {
        entry.previewError = true;
        entry.previewDataUrl = null;
        image.replaceWith(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
      }, { once: true });
      item.append(image);
      if (!entry.previewDataUrl && !entry.previewLoading) {
        entry.previewLoading = true;
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          entry.previewLoading = false;
          if (typeof reader.result === 'string') {
            entry.previewDataUrl = reader.result;
            if (image.isConnected) image.src = entry.previewDataUrl;
            renderWizardPhotoOptions();
          } else {
            entry.previewError = true;
            if (image.isConnected) image.replaceWith(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
            renderWizardPhotoOptions();
          }
        }, { once: true });
        reader.addEventListener('error', () => {
          entry.previewLoading = false;
          entry.previewError = true;
          if (image.isConnected) image.replaceWith(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
          renderWizardPhotoOptions();
        }, { once: true });
        reader.readAsDataURL(entry.file);
      }
    }
    const info = element('div', 'photo-selection-info');
    info.append(element('strong', '', entry.file.name));
    info.append(element('span', 'field-help', `${Math.ceil(entry.file.size / 1024)} KB · ${entry.status}`));
    item.append(info);
    const remove = makeButton('Quitar', 'button button-text', () => {
      if (wizardPhotoUploadInProgress) return;
      if (wizardCoverKey === `file:${entry.id}`) wizardCoverKey = null;
      wizardPhotoFiles.splice(wizardPhotoFiles.indexOf(entry), 1);
      wizardMediaOrder = wizardMediaOrder.filter((key) => key !== `file:${entry.id}`);
      if (entry.media) {
        document.querySelector('#wizard-photo-status').textContent = 'La foto ya cargada quedará privada en la bandeja y no se asociará a este mueble.';
      }
      renderWizardPhotoOptions();
      if (currentWizardStep === 5) renderProductReview();
    });
    remove.disabled = wizardPhotoUploadInProgress;
    remove.setAttribute('aria-label', `Quitar ${entry.file.name} de este mueble`);
    item.append(remove);
    selectedList.append(item);
  }

  const candidates = [
    ...wizardExistingMedia.filter((media) => media.keep).map((media) => ({ key: `media:${media.id}`, imageUrl: media.adminUrl, label: `Foto guardada${media.isPublic === false ? ' · privada' : ''}`, alt: media.altText || 'Foto del mueble' })),
    ...(wizardPendingPhoto ? [{ key: `pending:${wizardPendingPhoto.id}`, imageUrl: wizardPendingPhoto.adminUrl, label: `${wizardPendingPhoto.original_filename} · pendiente`, alt: wizardPendingPhoto.original_filename }] : []),
    ...wizardPhotoFiles.map((entry) => ({ key: `file:${entry.id}`, imageUrl: entry.previewDataUrl, label: entry.media ? `${entry.file.name} · guardada en bandeja privada` : `${entry.file.name} · seleccionada`, alt: entry.file.name })),
  ];
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const knownKeys = new Set([
    ...wizardExistingMedia.map((media) => `media:${media.id}`),
    ...(wizardPendingPhoto ? [`pending:${wizardPendingPhoto.id}`] : []),
    ...wizardPhotoFiles.map((entry) => `file:${entry.id}`),
  ]);
  wizardMediaOrder = wizardMediaOrder.filter((key) => knownKeys.has(key));
  for (const candidate of candidates) {
    if (!wizardMediaOrder.includes(candidate.key)) wizardMediaOrder.push(candidate.key);
  }
  const orderedCandidates = wizardMediaOrder.filter((key) => candidatesByKey.has(key)).map((key) => candidatesByKey.get(key));
  if (!orderedCandidates.length) {
    coverOptions.append(element('p', 'field-help', 'Agrega una fotografía para elegir la portada.'));
  } else {
    if (!orderedCandidates.some((candidate) => candidate.key === wizardCoverKey)) {
      wizardCoverKey = orderedCandidates.find((candidate) => candidate.key.startsWith('media:'))?.key ?? orderedCandidates[0].key;
    }
    for (const [index, candidate] of orderedCandidates.entries()) {
      const card = element('div', 'wizard-cover-option');
      if (candidate.imageUrl) {
        const image = element('img');
        image.src = candidate.imageUrl;
        image.alt = candidate.alt;
        image.loading = 'lazy';
        card.append(image);
      } else {
        card.append(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa en preparación'));
      }
      const label = element('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'wizard-cover-choice';
      radio.checked = candidate.key === wizardCoverKey;
      radio.addEventListener('change', () => setWizardCover(candidate.key));
      label.append(radio, document.createTextNode(candidate.label));
      card.append(label);
      const ordering = element('div', 'wizard-photo-order-actions');
      const moveEarlier = makeButton('Subir', 'button button-text', () => moveWizardPhoto(candidate.key, -1));
      const moveLater = makeButton('Bajar', 'button button-text', () => moveWizardPhoto(candidate.key, 1));
      moveEarlier.disabled = index === 0;
      moveLater.disabled = index === orderedCandidates.length - 1;
      ordering.append(moveEarlier, moveLater);
      card.append(ordering);
      coverOptions.append(card);
    }
  }

  const validFiles = wizardPhotoFiles.filter((entry) => !entry.media && !entry.formatRejected
    && entry.file.size > 0 && entry.file.size <= photoMaxFileBytes
    && !entry.status.startsWith('Error:'));
  const retryFiles = wizardPhotoFiles.filter((entry) => !entry.media && entry.status.startsWith('Error:'));
  document.querySelector('#wizard-photo-retry').hidden = retryFiles.length === 0;
  document.querySelector('#wizard-photo-retry').disabled = wizardPhotoUploadInProgress;
  document.querySelector('#wizard-photo-upload').disabled = wizardPhotoUploadInProgress
    || validFiles.length === 0 || validFiles.length > photoMaxBatchFiles;
}

function moveWizardPhoto(key, direction) {
  const activeKeys = new Set([
    ...wizardExistingMedia.filter((media) => media.keep).map((media) => `media:${media.id}`),
    ...(wizardPendingPhoto ? [`pending:${wizardPendingPhoto.id}`] : []),
    ...wizardPhotoFiles.map((entry) => `file:${entry.id}`),
  ]);
  const orderedActive = wizardMediaOrder.filter((candidateKey) => activeKeys.has(candidateKey));
  const index = orderedActive.indexOf(key);
  const targetKey = orderedActive[index + direction];
  if (index < 0 || !targetKey) return;
  const sourceIndex = wizardMediaOrder.indexOf(key);
  const targetIndex = wizardMediaOrder.indexOf(targetKey);
  [wizardMediaOrder[sourceIndex], wizardMediaOrder[targetIndex]] = [wizardMediaOrder[targetIndex], wizardMediaOrder[sourceIndex]];
  wizardGalleryDirty = true;
  renderWizardPhotoOptions();
  if (currentWizardStep === 5) renderProductReview();
}

function addWizardPhotoFiles(files) {
  for (const file of files) {
    const formatRejected = Boolean(file.type) && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    const status = formatRejected
      ? 'Formato no admitido; usa JPG, PNG o WebP'
      : file.size === 0
        ? 'El archivo está vacío'
        : file.size > photoMaxFileBytes
          ? `Supera el límite de ${Math.ceil(photoMaxFileBytes / (1024 * 1024))} MB`
          : 'Lista para subir';
    const entry = { id: crypto.randomUUID(), file, status, formatRejected };
    wizardPhotoFiles.push(entry);
    wizardMediaOrder.push(`file:${entry.id}`);
  }
  wizardGalleryDirty = true;
  if (wizardPhotoFiles.length > photoMaxBatchFiles) {
    document.querySelector('#wizard-photo-status').textContent = `El límite es de ${photoMaxBatchFiles} fotos por lote. Quita algunas antes de subir.`;
    document.querySelector('#wizard-photo-status').dataset.state = 'error';
  } else if (wizardPhotoFiles.some((entry) => entry.formatRejected || entry.file.size === 0 || entry.file.size > photoMaxFileBytes)) {
    document.querySelector('#wizard-photo-status').textContent = 'Revisa los archivos marcados antes de subirlos.';
    document.querySelector('#wizard-photo-status').dataset.state = 'error';
  }
  if (!wizardCoverKey && wizardPhotoFiles.length) wizardCoverKey = `file:${wizardPhotoFiles[0].id}`;
  renderWizardPhotoOptions();
}

async function uploadWizardPhotos(retryOnly = false) {
  if (wizardPhotoUploadInProgress) return;
  const entries = wizardPhotoFiles.filter((entry) => !entry.media && !entry.formatRejected
    && entry.file.size > 0 && entry.file.size <= photoMaxFileBytes
    && (retryOnly ? entry.status.startsWith('Error:') : !entry.status.startsWith('Error:')));
  if (!entries.length) return;
  if (entries.length > photoMaxBatchFiles) {
    document.querySelector('#wizard-photo-status').textContent = `El límite es de ${photoMaxBatchFiles} fotos por lote. Quita algunas antes de subir.`;
    document.querySelector('#wizard-photo-status').dataset.state = 'error';
    return;
  }
  wizardPhotoUploadInProgress = true;
  renderWizardPhotoOptions();
  const batchId = crypto.randomUUID();
  let uploaded = 0;
  let failed = 0;
  for (const entry of entries) {
    entry.status = 'Subiendo…';
    renderWizardPhotoOptions();
    try {
      const response = await fetch(`/api/admin/media/upload/${batchId}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken, 'X-Original-Filename': encodeURIComponent(entry.file.name) },
        body: entry.file,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.assign('/admin/login');
        throw new Error('La sesión terminó. Inicia sesión nuevamente.');
      }
      if (!response.ok) throw new Error(result.error || 'El servidor no pudo guardar esta fotografía.');
      if (!result.media?.id) throw new Error('El servidor no confirmó la fotografía. Puedes volver a intentarlo.');
      entry.media = result.media;
      entry.status = 'Guardada en bandeja privada';
      uploaded += 1;
    } catch (error) {
      entry.status = `Error: ${error.message}`;
      failed += 1;
    }
    renderWizardPhotoOptions();
  }
  wizardPhotoUploadInProgress = false;
  renderWizardPhotoOptions();
  const status = document.querySelector('#wizard-photo-status');
  status.textContent = `${uploaded} fotografías guardadas en la bandeja privada${failed ? ` · ${failed} fallidas; puedes reintentarlas` : ''}. Aún no son públicas.`;
  status.dataset.state = failed ? 'error' : 'success';
  if (uploaded) showNotification(`${uploaded} ${uploaded === 1 ? 'fotografía guardada' : 'fotografías guardadas'} en la bandeja privada.`);
  if (failed) showNotification(`${failed} ${failed === 1 ? 'fotografía no se pudo guardar' : 'fotografías no se pudieron guardar'}. Revisa el estado y vuelve a intentarlo.`, { type: 'error' });
}

async function classifyWizardPhotos(productId, entries) {
  const unclassified = entries.filter((entry) => !entry.classified);
  if (!unclassified.length) return;
  const mediaIds = unclassified.map((entry) => entry.media?.id ?? entry.id);
  try {
    await api('/api/admin/media/classify', {
      method: 'POST',
      body: JSON.stringify({ mediaIds, productId }),
    });
    unclassified.forEach((entry) => { entry.classified = true; });
  } catch (error) {
    try {
      const { products } = await api('/api/admin/products');
      const savedProduct = products.find((product) => String(product.id) === String(productId));
      const linkedMedia = new Set((savedProduct?.media ?? []).map((media) => String(media.id)));
      if (mediaIds.every((id) => linkedMedia.has(String(id)))) {
        unclassified.forEach((entry) => { entry.classified = true; });
        return;
      }
    } catch {
      // Se conserva el error original; un reintento seguro podrá comprobar el vínculo.
    }
    throw error;
  }
}

async function saveWizardGallery(productId) {
  const retained = wizardExistingMedia.filter((media) => media.keep);
  const uploaded = wizardPhotoFiles.filter((entry) => entry.media);
  const pending = wizardPendingPhoto ? [wizardPendingPhoto] : [];
  const unclassified = [...uploaded, ...pending];
  if (!wizardGalleryDirty && unclassified.length === 0) return;
  if (unclassified.length) await classifyWizardPhotos(productId, unclassified);

  const mediaByKey = new Map([
    ...retained.map((media) => [`media:${media.id}`, String(media.id)]),
    ...pending.map((entry) => [`pending:${entry.id}`, String(entry.id)]),
    ...uploaded.map((entry) => [`file:${entry.id}`, String(entry.media.id)]),
  ]);
  const mediaIds = wizardMediaOrder.map((key) => mediaByKey.get(key)).filter(Boolean);
  const coverId = resolveWizardCover();
  const publicMediaIds = retained.filter((media) => media.isPublic !== false).map((media) => String(media.id));
  await api(`/api/admin/products/${encodeURIComponent(String(productId))}/media`, {
    method: 'PUT',
    body: JSON.stringify({ mediaIds, coverMediaId: coverId, publicMediaIds }),
  });
}

function resetCategoryForm() {
  categoryForm.reset();
  document.querySelector('#category-id').value = '';
  document.querySelector('#category-form-title').textContent = 'Nueva categoría';
  document.querySelector('#category-active').checked = true;
  document.querySelector('#cancel-category-edit').hidden = true;
  renderMeasurementEditor('category-template-dimensions', null);
  categorySlugEdited = false;
}

function resetProductForm() {
  for (const url of wizardVideoPreviewUrls.values()) URL.revokeObjectURL(url);
  wizardVideoPreviewUrls.clear();
  productForm.reset();
  productForm.hidden = false;
  document.querySelector('#product-save-result').hidden = true;
  document.querySelector('#wizard-new-category-panel').hidden = true;
  document.querySelector('#wizard-new-category-name').value = '';
  document.querySelector('#wizard-category-status').textContent = '';
  document.querySelector('#wizard-photo-status').textContent = '';
  wizardPhotoFiles.length = 0;
  wizardPhotoUploadInProgress = false;
  wizardPendingPhoto = null;
  wizardExistingMedia = [];
  wizardExistingVideos = [];
  wizardSelectedVideos = [];
  wizardRemovedVideoIds = new Set();
  wizardMediaOrder = [];
  wizardCoverKey = null;
  wizardGalleryDirty = false;
  document.querySelector('#product-id').value = '';
  document.querySelector('#product-form-title').textContent = 'Nuevo trabajo';
  document.querySelector('#save-draft-button').textContent = 'Guardar mueble';
  document.querySelector('#save-publish-button').textContent = 'Guardar y publicar';
  document.querySelector('#save-publish-button').hidden = false;
  document.querySelector('#save-draft-choice').hidden = false;
  document.querySelector('#save-draft-choice').textContent = 'Guardar como borrador. Solo tú lo verás en este panel. Puedes completarlo y publicarlo más adelante.';
  document.querySelector('#save-publish-choice').hidden = false;
  document.querySelector('#cancel-product-edit').textContent = 'Cerrar asistente';
  productSlugEdited = false;
  editingProduct = null;
  productMeasurementsTouched = false;
  fixedDimensionsFormatUnknown = false;
  document.querySelector('#add-fixed-dimension').disabled = false;
  document.querySelector('#fixed-dimensions-legacy-note').hidden = true;
  selectedProductCategoryId = '';
  document.querySelector('#product-category').dispatchEvent(new Event('change', { bubbles: true }));
  renderMeasurementEditor('product-dimensions', null, () => { productMeasurementsTouched = true; });
  renderFixedDimensionEditor(null);
  renderWizardMedia(null);
  updateProductTemplateInfo();
  setWizardStep(1);
  productEditor.hidden = true;
}

function editCategory(category) {
  document.querySelector('#category-id').value = category.id;
  document.querySelector('#category-name').value = category.name;
  document.querySelector('#category-slug').value = category.slug;
  document.querySelector('#category-description').value = category.description ?? '';
  renderMeasurementEditor('category-template-dimensions', category.measurement_template);
  document.querySelector('#category-active').checked = category.is_active;
  document.querySelector('#category-form-title').textContent = `Editar: ${category.name}`;
  document.querySelector('#cancel-category-edit').hidden = false;
  categorySlugEdited = true;
  categoryForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('#category-name').focus();
}

function editProduct(product) {
  navigateAdminView('products-section');
  productEditor.hidden = false;
  productForm.hidden = false;
  document.querySelector('#product-save-result').hidden = true;
  editingProduct = product;
  wizardPendingPhoto = null;
  document.querySelector('#product-id').value = product.id;
  document.querySelector('#product-name').value = product.name;
  document.querySelector('#product-slug').value = product.slug;
  document.querySelector('#product-description').value = product.description ?? '';
  document.querySelector('#product-category').value = product.category_id ?? '';
  selectedProductCategoryId = String(product.category_id ?? '');
  renderMeasurementEditor('product-dimensions', product.measurement_config, () => { productMeasurementsTouched = true; });
  productMeasurementsTouched = Boolean(product.measurement_config?.dimensions?.length);
  const fixedDimensions = inspectFixedDimensions(product.dimensions);
  fixedDimensionsFormatUnknown = !fixedDimensions.recognized;
  document.querySelector('#add-fixed-dimension').disabled = fixedDimensionsFormatUnknown;
  document.querySelector('#fixed-dimensions-legacy-note').hidden = !fixedDimensionsFormatUnknown;
  renderFixedDimensionEditor(fixedDimensions.config, fixedDimensionsFormatUnknown);
  document.querySelector('#product-category').dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#product-form-title').textContent = `Editar: ${product.name}`;
  document.querySelector('#save-draft-button').textContent = product.is_published ? 'Guardar cambios' : 'Guardar como borrador';
  document.querySelector('#save-publish-button').hidden = product.is_published;
  document.querySelector('#save-publish-choice').hidden = product.is_published;
  document.querySelector('#save-draft-choice').textContent = product.is_published
    ? 'Guardar cambios. El producto seguirá publicado.'
    : 'Guardar como borrador. Solo tú lo verás en este panel; podrás publicarlo más adelante.';
  document.querySelector('#cancel-product-edit').textContent = 'Cerrar asistente';
  renderWizardMedia(product);
  productSlugEdited = false;
  updateProductTemplateInfo();
  setWizardStep(1);
  productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('#product-name').focus();
}

function renderCategories(categories, products = currentProducts) {
  categoryList.replaceChildren();
  currentCategories = categories;
  categoriesById = new Map(categories.map((category) => [String(category.id), category]));
  const select = document.querySelector('#product-category');
  const wizardCategoryList = document.querySelector('#wizard-category-list');
  const previousSelection = select.value;
  select.replaceChildren(new Option('Selecciona una categoría', ''));
  wizardCategoryList.replaceChildren();

  if (categories.length === 0) {
    categoryList.append(element('li', 'admin-empty', 'Aún no hay categorías. Crea una para poder organizar trabajos.'));
    wizardCategoryList.append(element('p', 'admin-empty', 'Todavía no hay categorías. Crea una para poder continuar.'));
  }

  for (const category of categories) {
    select.add(new Option(`${category.name}${category.is_active ? '' : ' (inactiva)'}`, category.id));
    const categoryOption = element('label', 'wizard-category-option');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'wizard-product-category';
    radio.value = String(category.id);
    radio.checked = String(category.id) === previousSelection;
    radio.setAttribute('aria-label', `${category.name}${category.is_active ? '' : ', categoría inactiva'}`);
    radio.addEventListener('change', () => {
      select.value = radio.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      for (const option of wizardCategoryList.querySelectorAll('.wizard-category-option')) {
        option.classList.toggle('is-selected', option.querySelector('input')?.checked === true);
      }
    });
    const categoryName = element('span', '', category.name);
    const categoryState = element('small', '', category.is_active ? 'Activa' : 'Inactiva');
    categoryOption.style.marginInlineStart = `${Math.min(categoryDepth(category, categories), 4) * .8}rem`;
    categoryOption.append(radio, categoryName, categoryState);
    if (radio.checked) categoryOption.classList.add('is-selected');
    wizardCategoryList.append(categoryOption);
    const item = element('li', 'admin-record');
    const hasMeasurementTemplate = category.measurement_template !== null && category.measurement_template !== undefined;
    const hasPricingRules = category.pricing_rules !== null && category.pricing_rules !== undefined;
    item.append(element('h3', '', category.name));
    item.append(element('span', 'admin-badge', category.is_active ? 'Activa' : 'Inactiva'));
    item.append(element('p', 'admin-record-meta', hasMeasurementTemplate
      ? `Plantilla: ${dimensionCountMessage(category.measurement_template)}`
      : 'Sin plantilla de medidas'));
    item.append(element('p', 'admin-record-meta', `/${category.slug}`));

    const linkedProducts = Array.isArray(products)
      ? products.filter((product) => String(product.category_id ?? '') === String(category.id))
      : null;
    const childCategories = categories.filter((candidate) => String(candidate.parent_id ?? '') === String(category.id));
    const dependencyLabels = [
      linkedProducts === null ? 'trabajos sin comprobar' : `${linkedProducts.length} ${linkedProducts.length === 1 ? 'trabajo' : 'trabajos'}`,
      `${childCategories.length} ${childCategories.length === 1 ? 'subcategoría' : 'subcategorías'}`,
      ...(hasMeasurementTemplate ? ['plantilla de medidas'] : []),
      ...(hasPricingRules ? ['regla de precio'] : []),
    ];
    const dependencies = element('details', 'category-dependencies');
    dependencies.dataset.categoryId = String(category.id);
    dependencies.append(element('summary', '', `Ver dependencias: ${dependencyLabels.join(' · ')}`));

    if (linkedProducts === null) {
      dependencies.append(element('p', 'field-help', 'No se pudo consultar la lista de trabajos. La API comprobará las relaciones antes de permitir cualquier eliminación.'));
    } else if (linkedProducts.length) {
      dependencies.append(element('h4', '', 'Trabajos asociados'));
      dependencies.append(element('p', 'field-help', 'Al cambiar un trabajo de categoría, se conservan sus medidas. Si no tiene una regla de precio propia, puede aplicarse la regla de la nueva categoría; revísala antes de guardar.'));
      const productItems = element('ul', 'category-dependency-list');
      for (const product of linkedProducts) {
        const productItem = element('li', 'category-dependency-item');
        productItem.append(element('span', '', `${product.name} · ${product.is_published ? 'Publicado' : 'Borrador'}`));
        const productActions = element('div', 'category-dependency-actions');
        productActions.append(makeButton('Editar y cambiar categoría', 'button button-outline', () => editProduct(product)));
        productActions.append(makeButton('Eliminar trabajo', 'button button-danger', () => deleteProduct(product)));
        productItem.append(productActions);
        productItems.append(productItem);
      }
      dependencies.append(productItems);
    }

    if (childCategories.length) {
      dependencies.append(element('h4', '', 'Subcategorías asociadas'));
      const childItems = element('ul', 'category-dependency-list');
      for (const child of childCategories) {
        const childItem = element('li', 'category-dependency-item');
        childItem.append(element('span', '', child.name));
        const childActions = element('div', 'category-dependency-actions');
        childActions.append(makeButton('Editar subcategoría', 'button button-outline', () => editCategory(child)));
        childActions.append(makeButton('Eliminar subcategoría', 'button button-danger', () => deleteCategory(child)));
        childItem.append(childActions);
        childItems.append(childItem);
      }
      dependencies.append(childItems);
    }

    if (hasMeasurementTemplate || hasPricingRules) {
      const configuredItems = element('ul', 'category-dependency-list');
      if (hasMeasurementTemplate) configuredItems.append(element('li', '', 'Tiene una plantilla de medidas.'));
      if (hasPricingRules) configuredItems.append(element('li', '', 'Tiene una regla de precio.'));
      dependencies.append(element('h4', '', 'Configuración asociada'));
      dependencies.append(configuredItems);
      dependencies.append(element('p', 'field-help', 'Usa “Editar categoría” para retirar explícitamente la plantilla o la regla y guarda los cambios antes de eliminar.'));
    }

    if (linkedProducts?.length === 0 && childCategories.length === 0 && !hasMeasurementTemplate && !hasPricingRules) {
      dependencies.append(element('p', 'field-help', 'No tiene trabajos, subcategorías, plantilla de medidas ni regla de precio.'));
    }
    item.append(dependencies);

    const actions = element('div', 'admin-actions category-actions');
    actions.append(makeButton('Editar categoría', 'button button-outline', () => editCategory(category)));
    const deleteButton = makeButton('Eliminar', 'button button-danger', () => deleteCategory(category));
    deleteButton.setAttribute('aria-label', `Eliminar la categoría ${category.name}`);
    actions.append(deleteButton);
    item.append(actions);
    categoryList.append(item);
  }
  if (categoriesById.has(previousSelection)) select.value = previousSelection;
  selectedProductCategoryId = select.value;
  if (categoriesById.has(select.value)) {
    const selectedRadio = [...wizardCategoryList.querySelectorAll('input[name="wizard-product-category"]')]
      .find((radio) => radio.value === select.value);
    if (selectedRadio) selectedRadio.checked = true;
    selectedRadio?.closest('.wizard-category-option')?.classList.add('is-selected');
  }
  updateWizardCategorySelection();
  updateProductTemplateInfo();
}

function updateWizardCategorySelection() {
  const select = document.querySelector('#product-category');
  const category = categoriesById.get(String(select.value));
  const summary = document.querySelector('#wizard-category-selection');
  summary.textContent = category
    ? `Categoría seleccionada: ${category.name}${category.is_active ? '' : ' · Inactiva'}`
    : 'Aún no has seleccionado una categoría.';
  const nextButton = document.querySelector('#wizard-next');
  if (currentWizardStep === 2) nextButton.disabled = !category;
}

function setWizardCategoryLoadError(message) {
  const status = document.querySelector('#wizard-category-load-status');
  status.textContent = `No fue posible cargar las categorías. ${message || 'Comprueba la conexión y vuelve a intentarlo.'}`;
  status.dataset.state = 'error';
  document.querySelector('#wizard-retry-categories').hidden = false;
}

async function loadWizardCategories() {
  const showButton = document.querySelector('#wizard-show-categories');
  const retryButton = document.querySelector('#wizard-retry-categories');
  const list = document.querySelector('#wizard-category-list');
  const status = document.querySelector('#wizard-category-load-status');
  showButton.disabled = true;
  retryButton.disabled = true;
  status.textContent = 'Cargando categorías…';
  status.dataset.state = 'loading';
  try {
    const result = await api('/api/admin/categories');
    if (!Array.isArray(result.categories)) throw new Error('La respuesta del servidor no contiene una lista válida.');
    renderCategories(result.categories, currentProducts);
    list.hidden = false;
    showButton.setAttribute('aria-expanded', 'true');
    retryButton.hidden = true;
    status.textContent = result.categories.length
      ? `${result.categories.length} ${result.categories.length === 1 ? 'categoría disponible' : 'categorías disponibles'}.`
      : 'No hay categorías todavía. Puedes crear una nueva para continuar.';
    status.dataset.state = result.categories.length ? 'success' : 'empty';
    return true;
  } catch (error) {
    setWizardCategoryLoadError(error.message);
    return false;
  } finally {
    showButton.disabled = false;
    retryButton.disabled = false;
  }
}

function categoryDepth(category, categories) {
  const byId = new Map(categories.map((candidate) => [String(candidate.id), candidate]));
  const visited = new Set([String(category.id)]);
  let parentId = category.parent_id === null || category.parent_id === undefined ? null : String(category.parent_id);
  let depth = 0;
  while (parentId && byId.has(parentId) && depth < 4 && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    const parent = byId.get(parentId);
    parentId = parent.parent_id === null || parent.parent_id === undefined ? null : String(parent.parent_id);
  }
  return depth;
}

function openCategoryDependencies(categoryId) {
  for (const details of categoryList.querySelectorAll('.category-dependencies')) {
    if (details.dataset.categoryId === String(categoryId)) {
      details.open = true;
      return;
    }
  }
}

function updateProductTemplateInfo() {
  const category = categoriesById.get(document.querySelector('#product-category').value);
  const applyButton = document.querySelector('#apply-category-template');
  const template = category?.measurement_template;
  const help = document.querySelector('#product-template-help');
  applyButton.disabled = !template?.dimensions?.length;
  if (template?.dimensions?.length) {
    help.textContent = `Esta categoría tiene una plantilla con ${dimensionCountMessage(template)}. Al usarla, puedes cambiar esta copia sin modificar la plantilla.`;
  } else if (category) {
    help.textContent = 'Esta categoría no tiene plantilla. Puedes agregar medidas manualmente o crear una desde “Organizar categorías”.';
  } else {
    help.textContent = 'Elige una categoría para revisar si tiene una plantilla.';
  }
}

function applyCategoryTemplate(confirmReplace = true) {
  const category = categoriesById.get(document.querySelector('#product-category').value);
  const template = category?.measurement_template;
  if (!template?.dimensions?.length) {
    setStatus('Esta categoría todavía no tiene una plantilla de medidas.', true);
    return false;
  }
  const existing = readMeasurementRows('product-dimensions');
  if (confirmReplace && existing.length && !window.confirm('Se quitarán las medidas actuales de este producto y se copiarán las de la categoría. La plantilla de la categoría no cambiará. Después podrás personalizar esta copia. ¿Deseas continuar?')) {
    return false;
  }
  renderMeasurementEditor('product-dimensions', JSON.parse(JSON.stringify(template)), () => { productMeasurementsTouched = true; });
  productMeasurementsTouched = true;
  setStatus('Plantilla copiada. Ahora puedes ajustar las medidas solo para este producto.');
  return true;
}

function measurementRowsMatchTemplate(rows, template) {
  if (rows.length !== template?.dimensions?.length) return false;
  try {
    return rows.every((row, index) => {
      const dimension = template.dimensions[index];
      const min = parseDecimal(row.min_m, 'Límite mínimo', true) ?? 0;
      const max = parseDecimal(row.max_m, 'Límite máximo', true);
      const templateMin = dimension.min_m ?? 0;
      const templateMax = dimension.max_m ?? null;
      return row.key === dimension.key
        && row.label.trim() === dimension.label
        && row.help.trim() === (dimension.help ?? '')
        && min === templateMin
        && max === templateMax
        && row.required === (dimension.required !== false);
    });
  } catch {
    return false;
  }
}

function handleProductCategoryChange() {
  const select = document.querySelector('#product-category');
  const newCategoryId = select.value;
  const category = categoriesById.get(newCategoryId);
  const wizardCategoryList = document.querySelector('#wizard-category-list');
  for (const option of wizardCategoryList.querySelectorAll('.wizard-category-option')) {
    const radio = option.querySelector('input[type="radio"]');
    radio.checked = radio.value === newCategoryId;
    option.classList.toggle('is-selected', radio.checked);
  }
  if (newCategoryId !== selectedProductCategoryId) {
    const hasProductMeasurements = readMeasurementRows('product-dimensions').length > 0;
    if (productMeasurementsTouched && hasProductMeasurements && category?.measurement_template?.dimensions?.length) {
      if (measurementRowsMatchTemplate(readMeasurementRows('product-dimensions'), category.measurement_template)) {
        setStatus(`La plantilla de “${category.name}” coincide con las medidas actuales; se conservaron.`);
      } else {
        const shouldApply = window.confirm(`La plantilla de “${category.name}” propone otras medidas para pedir al cliente. ¿Quieres reemplazar solo esa lista por una copia? Las dimensiones fijas del producto y la plantilla original no cambiarán. Si eliges Cancelar, conservarás las medidas actuales.`);
        if (shouldApply) applyCategoryTemplate(false);
      }
    } else if (productMeasurementsTouched && hasProductMeasurements && category) {
      setStatus(`“${category.name}” no tiene plantilla. Se conservaron las medidas que ya configuraste.`);
    } else if (category?.measurement_template?.dimensions?.length) {
      setStatus('Hay una plantilla para esta categoría. Puedes copiarla en el paso Medidas cuando quieras.');
    }
  }
  selectedProductCategoryId = newCategoryId;
  updateWizardCategorySelection();
  updateProductTemplateInfo();
}

function renderMedia(product) {
  const section = element('div');
  const heading = element('p', 'admin-record-meta', 'Fotografías del producto');
  section.append(heading);
  const mediaItems = (product.media ?? []).filter((media) => media.kind === 'image').map((media) => ({ ...media }));
  const video = (product.media ?? []).find((media) => media.kind === 'video');
  if (!mediaItems.length) {
    section.append(element('p', 'field-help', 'Todavía no hay fotografías asociadas. Puedes elegir una de la biblioteca o cargar una nueva.'));
  } else {
    const list = element('ul', 'admin-media-list');
    for (const [index, media] of mediaItems.entries()) {
    const item = element('li', 'admin-media-item');
    if (media.kind === 'image') {
      const image = element('img', 'admin-media-thumb');
      image.src = media.adminUrl;
      image.alt = media.altText || `Fotografía ${index + 1} de ${product.name}`;
      image.loading = 'lazy';
      item.append(image);
    }
    const details = [media.kind === 'image' ? 'Imagen' : 'Video'];
    if (media.altText) details.push(media.altText);
    if (media.width && media.height) details.push(`${media.width} × ${media.height} px`);
    if (media.isCover) details.push('Portada');
    details.push(media.isPublic === false ? 'Oculta en tienda' : (product.is_published ? 'Visible en tienda' : 'Visible cuando publiques el producto'));
    item.append(element('span', '', details.join(' · ')));
    const controls = element('div', 'admin-actions admin-media-actions');
    controls.append(makeButton('Mover arriba', 'button button-text', () => {
      if (index === 0) return;
      const reordered = [...mediaItems];
      [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
      updateProductGallery(product, reordered, mediaItems.find((photo) => photo.isCover)?.id ?? null);
    }));
    controls.lastElementChild.disabled = index === 0;
    controls.append(makeButton('Bajar', 'button button-text', () => {
      if (index === mediaItems.length - 1) return;
      const reordered = [...mediaItems];
      [reordered[index + 1], reordered[index]] = [reordered[index], reordered[index + 1]];
      updateProductGallery(product, reordered, mediaItems.find((photo) => photo.isCover)?.id ?? null);
    }));
    controls.lastElementChild.disabled = index === mediaItems.length - 1;
    controls.append(makeButton(media.isCover ? 'Portada elegida' : 'Elegir portada', 'button button-text', () => {
      if (!media.isCover) updateProductGallery(product, mediaItems, media.id);
    }));
    controls.lastElementChild.disabled = Boolean(media.isCover);
    controls.append(makeButton(media.isPublic === false ? 'Mostrar en tienda' : 'Ocultar en tienda', 'button button-text', () => {
      const publicIds = mediaItems.filter((photo) => photo.id !== media.id
        ? photo.isPublic !== false : media.isPublic === false).map((photo) => photo.id);
      updateProductGallery(product, mediaItems, mediaItems.find((photo) => photo.isCover)?.id ?? null, publicIds);
    }));
    controls.append(makeButton('Retirar de galería', 'button button-text', () => {
      if (!window.confirm(`¿Retirar esta fotografía de “${product.name}”? Se conservará en la Biblioteca de imágenes y volverá a pendientes si ningún otro trabajo la utiliza.`)) return;
      const remaining = mediaItems.filter((photo) => String(photo.id) !== String(media.id));
      const newCover = media.isCover ? (remaining[0]?.id ?? null) : mediaItems.find((photo) => photo.isCover)?.id ?? null;
      const publicIds = remaining.filter((photo) => photo.isPublic !== false).map((photo) => photo.id);
      updateProductGallery(product, remaining, newCover, publicIds);
    }));
    item.append(controls);
    list.append(item);
    }
    section.append(list);
  }
  if (video) section.append(element('p', 'field-help', `Video asociado: ${video.originalFilename || 'video guardado'}. Puedes reemplazarlo o quitarlo al editar el trabajo.`));
  section.append(
    makeButton('Agregar fotografías', 'button button-outline', () => openPhotoInboxForProduct(product)),
    makeButton('Elegir de la biblioteca', 'button button-text', () => openImageLibraryForProduct(product)),
  );
  return section;
}

async function updateProductGallery(product, mediaItems, coverId, publicMediaIds = mediaItems.filter((media) => media.isPublic !== false).map((media) => media.id)) {
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(product.id)}/media`, {
      method: 'PUT',
      body: JSON.stringify({
        mediaIds: mediaItems.map((media) => media.id),
        coverMediaId: coverId,
        publicMediaIds,
      }),
    });
    if (await loadData()) {
      setStatus(result.message);
      showNotification(result.message);
    } else {
      const message = 'La galería se guardó, pero no se pudo actualizar la lista. Recarga el panel para ver el estado actual.';
      setStatus(message, true);
      showNotification(message, { type: 'error' });
    }
  } catch (error) {
    setStatus(`No se pudo actualizar la galería: ${error.message}`, true);
    showNotification(`No se pudo actualizar la galería: ${error.message}`, { type: 'error' });
  }
}

function openPhotoInboxForProduct(product) {
  preferredPhotoProductId = String(product.id);
  navigateAdminView('photo-inbox', { focus: true });
}

function openImageLibraryForProduct(product) {
  preferredPhotoProductId = String(product.id);
  navigateAdminView('image-library', { focus: true });
}

function renderProducts(products) {
  productList.replaceChildren();
  productsEmptyHelp.hidden = products.length !== 0;
  if (products.length === 0) {
    productList.append(element('li', 'admin-empty product-empty-card', 'Cuando agregues tu primer producto, aparecerá aquí. Los borradores solo son visibles para ti.'));
    productListStatus.textContent = '0 trabajos';
    return;
  }
  const query = productSearchInput.value.trim().toLocaleLowerCase('es');
  const state = productStatusFilter.value;
  const visibleProducts = products.filter((product) => {
    const searchable = `${product.name} ${product.description ?? ''} ${product.category_name ?? ''}`.toLocaleLowerCase('es');
    const matchesText = !query || searchable.includes(query);
    const matchesState = state === 'all' || (state === 'published' ? product.is_published : !product.is_published);
    return matchesText && matchesState;
  });
  productListStatus.textContent = `${visibleProducts.length} ${visibleProducts.length === 1 ? 'trabajo' : 'trabajos'}${visibleProducts.length !== products.length ? ` de ${products.length}` : ''}`;
  if (!visibleProducts.length) {
    productList.append(element('li', 'admin-empty product-empty-card', 'No hay trabajos que coincidan con estos filtros.'));
    return;
  }
  for (const product of visibleProducts) {
    const item = element('li', 'admin-record');
    const productPhotos = (product.media ?? []).filter((media) => media.kind === 'image');
    const cover = productPhotos.find((media) => media.isCover) ?? productPhotos[0];
    const image = cover?.adminUrl ? element('img', 'product-image-placeholder') : element('div', 'product-image-placeholder');
    if (cover?.adminUrl) {
      image.src = cover.adminUrl;
      image.alt = cover.altText || `Fotografía principal de ${product.name}`;
      image.loading = 'lazy';
    } else {
      image.setAttribute('role', 'img');
      image.setAttribute('aria-label', 'Fotografía pendiente');
      image.append(element('span', '', 'Fotografía pendiente'));
    }
    item.append(image);
    const heading = element('div', 'product-card-heading');
    heading.append(element('h3', '', product.name));
    const productStatus = product.is_published ? 'Publicado' : product.media?.length ? 'Borrador' : 'Falta completar';
    const badgeClass = product.is_published ? 'badge-published' : product.media?.length ? 'badge-draft' : 'badge-incomplete';
    heading.append(element('span', `admin-badge ${badgeClass}`, productStatus));
    item.append(heading);
    item.append(element('p', 'admin-record-meta', product.category_name ?? 'Sin categoría'));
    if (product.description) item.append(element('p', '', product.description));
    item.append(renderMedia(product));
    if (!product.media?.length) {
      const note = product.is_published
        ? 'Este trabajo no tiene fotografías asociadas.'
        : 'Sigue como borrador. Puedes agregar fotografías desde la bandeja privada.';
      item.append(element('p', 'product-incomplete-note', note));
    }
    const actions = element('div', 'admin-actions');
    actions.append(makeButton('Editar', 'button button-outline', () => editProduct(product)));
    if (product.is_published) {
      actions.append(makeButton('Ocultar de mi tienda', 'button button-text', () => changePublication(product, false)));
    } else {
      actions.append(makeButton('Publicar', 'button button-dark', () => changePublication(product, true)));
    }
    const deleteButton = makeButton('Eliminar trabajo', 'button button-danger', () => openProductDeleteDialog(product, deleteButton));
    deleteButton.setAttribute('aria-label', `Eliminar trabajo ${product.name}, ID ${product.id}`);
    actions.append(deleteButton);
    item.append(actions);
    productList.append(item);
  }
}

function renderSelectedPhotoFiles() {
  photoSelectionList.replaceChildren();
  const uploadButton = document.querySelector('#photo-upload-button');
  for (const entry of selectedPhotoFiles) {
    const item = element('li', 'photo-selection-item');
    if (entry.formatRejected) {
      item.append(element('div', 'photo-selection-thumb photo-selection-invalid', 'Formato no admitido'));
    } else if (entry.previewError) {
      item.append(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
    } else {
      const image = element('img', 'photo-selection-thumb');
      image.alt = '';
      if (entry.previewDataUrl) image.src = entry.previewDataUrl;
      image.addEventListener('error', () => {
        entry.previewError = true;
        entry.previewDataUrl = null;
        const fallback = element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible');
        image.replaceWith(fallback);
      }, { once: true });
      item.append(image);
      if (!entry.previewDataUrl && !entry.previewLoading) {
        entry.previewLoading = true;
        const reader = new FileReader();
        reader.addEventListener('load', () => {
          entry.previewLoading = false;
          if (typeof reader.result === 'string') {
            entry.previewDataUrl = reader.result;
            if (image.isConnected) image.src = entry.previewDataUrl;
          } else {
            entry.previewError = true;
            if (image.isConnected) image.replaceWith(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
          }
        }, { once: true });
        reader.addEventListener('error', () => {
          entry.previewLoading = false;
          entry.previewError = true;
          if (image.isConnected) {
            image.replaceWith(element('div', 'photo-selection-thumb photo-selection-invalid', 'Vista previa no disponible'));
          }
        }, { once: true });
        reader.readAsDataURL(entry.file);
      }
    }
    const info = element('div', 'photo-selection-info');
    info.append(element('strong', '', entry.file.name));
    info.append(element('span', 'field-help', `${Math.ceil(entry.file.size / 1024)} KB · ${entry.status}`));
    item.append(info);
    const remove = makeButton('Quitar', 'button button-text', () => {
      const index = selectedPhotoFiles.findIndex((candidate) => candidate.id === entry.id);
      if (index !== -1) selectedPhotoFiles.splice(index, 1);
      renderSelectedPhotoFiles();
    });
    remove.disabled = photoUploadInProgress || Boolean(entry.mediaId);
    remove.setAttribute('aria-label', `Quitar ${entry.file.name} de la selección`);
    item.append(remove);
    photoSelectionList.append(item);
  }
  const uploadable = selectedPhotoFiles.filter((entry) => !entry.mediaId && !entry.formatRejected
    && entry.file.size > 0 && entry.file.size <= photoMaxFileBytes);
  const failures = selectedPhotoFiles.filter((entry) => entry.status.startsWith('Error:'));
  const hasConfirmed = selectedPhotoFiles.some((entry) => Boolean(entry.mediaId));
  document.querySelector('#photo-files').disabled = photoUploadInProgress || hasConfirmed || failures.length > 0;
  document.querySelector('#photo-selected-count').textContent = `${selectedPhotoFiles.length} ${selectedPhotoFiles.length === 1 ? 'fotografía seleccionada' : 'fotografías seleccionadas'} · máximo ${photoMaxBatchFiles} por lote`;
  uploadButton.disabled = photoUploadInProgress || uploadable.length === 0
    || selectedPhotoFiles.length > photoMaxBatchFiles;
  const retryButton = document.querySelector('#photo-upload-retry');
  retryButton.hidden = failures.length === 0;
  retryButton.disabled = photoUploadInProgress || failures.length === 0;
  document.querySelector('#photo-upload-next-batch').hidden = !hasConfirmed || failures.length > 0 || photoUploadInProgress;
}

async function loadPhotoInbox() {
  const queryString = new URLSearchParams({ page: String(photoPage), q: photoSearchTerm });
  try {
    const result = await api(`/api/admin/media?${queryString}`);
    photoMaxBatchFiles = result.maxFilesPerBatch;
    photoMaxFileBytes = result.maxFileBytes;
    photoPage = result.page;
    photoPageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (photoPage > photoPageCount) {
      photoPage = photoPageCount;
      return loadPhotoInbox();
    }
    document.querySelector('#photo-pending-count').textContent = `${result.total} ${result.total === 1 ? 'fotografía pendiente' : 'fotografías pendientes'}`;
    photoPendingGrid.replaceChildren();
    if (!result.media.length) {
      photoPendingGrid.append(element('p', 'photo-inbox-empty', result.total
        ? 'No hay fotografías en esta página.'
        : (photoSearchTerm ? 'No encontramos fotografías pendientes con ese nombre.' : 'La bandeja está vacía. Cuando cargues fotografías aparecerán aquí.')));
    }
    for (const media of result.media) {
      const card = element('article', 'photo-pending-card');
      const image = element('img', 'photo-pending-thumb');
      image.src = media.adminUrl;
      image.alt = `Vista previa de ${media.original_filename}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      const title = element('p', 'photo-pending-name', media.original_filename || 'Fotografía sin nombre');
      const detailsParts = [String(media.mime_type || '').replace('image/', '').toUpperCase()];
      if (media.byte_size !== null && media.byte_size !== undefined && Number.isFinite(Number(media.byte_size))) {
        detailsParts.push(`${Math.ceil(Number(media.byte_size) / 1024)} KB`);
      }
      const details = element('p', 'field-help', detailsParts.filter(Boolean).join(' · '));
      const actions = element('div', 'photo-pending-actions');
      const assignButton = makeButton('Asignar a un mueble', 'button button-outline', () => {
        assignmentPanel.hidden = !assignmentPanel.hidden;
        if (!assignmentPanel.hidden) assignmentPanel.querySelector('select')?.focus();
      });
      const deleteButton = makeButton('Eliminar', 'button button-text photo-delete-button', () => deletePendingPhoto(media, deleteButton));
      actions.append(assignButton, deleteButton);
      const assignmentPanel = element('div', 'photo-assignment-panel');
      assignmentPanel.hidden = true;
      if (currentProducts === null) {
        assignmentPanel.append(element('p', 'field-help', 'No fue posible cargar los muebles. Actualiza el panel e inténtalo de nuevo.'));
      } else {
        const productLabel = element('label', 'field-label', 'Mueble existente');
        const productSelect = document.createElement('select');
        productSelect.setAttribute('aria-label', `Elegir mueble para ${media.original_filename || 'la fotografía'}`);
        productSelect.append(new Option('Selecciona un mueble', ''));
        for (const product of currentProducts) {
          productSelect.append(new Option(`${product.name} · ${product.is_published ? 'Publicado' : 'Borrador'}`, String(product.id)));
        }
        if ((currentProducts ?? []).some((product) => String(product.id) === preferredPhotoProductId)) productSelect.value = preferredPhotoProductId;
        const assignExisting = makeButton('Confirmar asignación', 'button button-dark', () => assignPendingPhoto(media, productSelect.value, assignExisting));
        assignExisting.disabled = currentProducts.length === 0;
        productLabel.append(productSelect);
        assignmentPanel.append(productLabel, assignExisting);
        const createButton = makeButton('Crear mueble nuevo', 'button button-text', () => openWizardWithPendingPhoto(media));
        assignmentPanel.append(createButton);
      }
      card.append(image, title, details, actions, assignmentPanel);
      photoPendingGrid.append(card);
    }
    document.querySelector('#photo-page-status').textContent = `Página ${result.page} de ${Math.max(1, photoPageCount)} · ${result.total} pendientes`;
    document.querySelector('#photo-page-previous').disabled = result.page <= 1;
    document.querySelector('#photo-page-next').disabled = result.page >= photoPageCount;
    document.querySelector('#photo-upload-help').textContent = `Formatos aceptados: JPG, PNG y WebP. Máximo ${Math.ceil(photoMaxFileBytes / (1024 * 1024))} MB por fotografía y ${photoMaxBatchFiles} por lote.`;
    renderSelectedPhotoFiles();
  } catch (error) {
    photoPendingGrid.replaceChildren(element('p', 'photo-inbox-empty', 'No fue posible cargar la bandeja privada.'));
    document.querySelector('#photo-page-status').textContent = '';
    photoInboxStatus.textContent = error.message;
    photoInboxStatus.dataset.state = 'error';
  }
}

async function loadImageLibrary() {
  const queryString = new URLSearchParams({ page: String(imageLibraryPage), q: imageLibrarySearchTerm });
  const grid = document.querySelector('#image-library-grid');
  const status = document.querySelector('#image-library-status');
  try {
    const result = await api(`/api/admin/media/library?${queryString}`);
    imageLibraryPage = result.page;
    imageLibraryPageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (imageLibraryPage > imageLibraryPageCount) {
      imageLibraryPage = imageLibraryPageCount;
      return loadImageLibrary();
    }
    document.querySelector('#image-library-count').textContent = `${result.total} ${result.total === 1 ? 'fotografía en la biblioteca' : 'fotografías en la biblioteca'}`;
    grid.replaceChildren();
    if (!result.media.length) {
      grid.append(element('p', 'photo-inbox-empty', imageLibrarySearchTerm
        ? 'No encontramos fotografías con ese nombre de archivo o trabajo.'
        : 'La biblioteca está vacía. Las fotografías aparecerán aquí cuando las subas.'));
    }
    for (const media of result.media) {
      const card = element('article', 'photo-pending-card');
      const image = element('img', 'photo-pending-thumb');
      image.src = media.adminUrl;
      image.alt = `Vista previa de ${media.original_filename || 'fotografía sin nombre'}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      card.append(image, element('p', 'photo-pending-name', media.original_filename || 'Fotografía sin nombre'));

      const details = [String(media.mime_type || '').replace('image/', '').toUpperCase()];
      if (media.byte_size !== null && media.byte_size !== undefined && Number.isFinite(Number(media.byte_size))) {
        details.push(`${Math.ceil(Number(media.byte_size) / 1024)} KB`);
      }
      details.push(media.classification_status === 'assigned' ? 'Asignada' : 'Sin asignar');
      details.push(media.is_public ? 'Habilitada para el catálogo' : 'No habilitada para el catálogo');
      card.append(element('p', 'field-help', details.join(' · ')));

      const products = Array.isArray(media.products) ? media.products : [];
      card.append(element('p', 'field-help', products.length
        ? `Trabajos que la utilizan: ${products.map((product) => `${product.name} (${product.isPublished ? 'publicado' : 'borrador'})`).join(', ')}`
        : 'No está asociada a ningún trabajo.'));

      const assignmentPanel = element('div', 'photo-assignment-panel');
      const productLabel = element('label', 'field-label', 'Asignar a otro trabajo');
      const productSelect = document.createElement('select');
      productSelect.setAttribute('aria-label', `Elegir trabajo para ${media.original_filename || 'la fotografía'}`);
      productSelect.append(new Option('Selecciona un trabajo', ''));
      const linkedIds = new Set(products.map((product) => String(product.id)));
      const assignableProducts = (currentProducts ?? []).filter((product) => !linkedIds.has(String(product.id)));
      for (const product of assignableProducts) {
        productSelect.append(new Option(`${product.name} · ${product.is_published ? 'Publicado' : 'Borrador'}`, String(product.id)));
      }
      if (assignableProducts.some((product) => String(product.id) === preferredPhotoProductId)) {
        productSelect.value = preferredPhotoProductId;
      }
      const assignButton = makeButton('Asignar fotografía', 'button button-dark', () => assignLibraryPhoto(media, productSelect.value, assignButton));
      assignButton.disabled = currentProducts === null || assignableProducts.length === 0;
      productLabel.append(productSelect);
      assignmentPanel.append(productLabel, assignButton);

      const deleteButton = makeButton('Eliminar de la biblioteca', 'button button-text photo-delete-button', () => deleteLibraryPhoto(media, deleteButton));
      const actions = element('div', 'photo-pending-actions');
      actions.append(deleteButton);
      card.append(assignmentPanel, actions);
      grid.append(card);
    }
    document.querySelector('#image-library-page-status').textContent = `Página ${result.page} de ${Math.max(1, imageLibraryPageCount)} · ${result.total} fotografías`;
    document.querySelector('#image-library-previous').disabled = result.page <= 1;
    document.querySelector('#image-library-next').disabled = result.page >= imageLibraryPageCount;
  } catch (error) {
    grid.replaceChildren(element('p', 'photo-inbox-empty', 'No fue posible cargar la biblioteca de imágenes.'));
    document.querySelector('#image-library-page-status').textContent = '';
    status.textContent = error.message;
    status.dataset.state = 'error';
  }
}

async function assignLibraryPhoto(media, productId, button) {
  if (!productId) {
    const status = document.querySelector('#image-library-status');
    status.textContent = 'Selecciona un trabajo antes de confirmar.';
    status.dataset.state = 'error';
    return;
  }
  button.disabled = true;
  try {
    const result = await api(`/api/admin/media/${encodeURIComponent(media.id)}/assign`, {
      method: 'POST',
      body: JSON.stringify({ productId }),
    });
    await loadData();
    const status = document.querySelector('#image-library-status');
    status.textContent = result.message;
    status.dataset.state = 'success';
  } catch (error) {
    const status = document.querySelector('#image-library-status');
    status.textContent = error.message;
    status.dataset.state = 'error';
    button.disabled = false;
  }
}

async function deleteLibraryPhoto(media, button) {
  if (!window.confirm(`¿Eliminar definitivamente “${media.original_filename || 'esta fotografía'}” de la biblioteca?`)) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/media/${encodeURIComponent(media.id)}`, { method: 'DELETE' });
    await loadData();
    const status = document.querySelector('#image-library-status');
    status.textContent = result.message || 'Se eliminó la fotografía de la biblioteca.';
    status.dataset.state = result.warning ? 'error' : 'success';
    showNotification(status.textContent, { type: result.warning ? 'error' : 'success' });
  } catch (error) {
    const status = document.querySelector('#image-library-status');
    status.textContent = error.message;
    status.dataset.state = 'error';
    showNotification(error.message, { type: 'error' });
    button.disabled = false;
  }
}

async function assignPendingPhoto(media, productId, button) {
  if (!productId) {
    photoInboxStatus.textContent = 'Selecciona un mueble antes de confirmar.';
    photoInboxStatus.dataset.state = 'error';
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/api/admin/media/classify', {
      method: 'POST',
      body: JSON.stringify({ mediaIds: [media.id], productId }),
    });
    preferredPhotoProductId = String(productId);
    await loadData();
    photoInboxStatus.textContent = result.message || `La fotografía “${media.original_filename}” se asignó al mueble.`;
    photoInboxStatus.dataset.state = 'success';
  } catch (error) {
    photoInboxStatus.textContent = error.message;
    photoInboxStatus.dataset.state = 'error';
    button.disabled = false;
  }
}

function openWizardWithPendingPhoto(media) {
  if (currentCategories.length === 0) {
    photoInboxStatus.textContent = 'Crea o activa una categoría antes de iniciar un mueble nuevo.';
    photoInboxStatus.dataset.state = 'error';
    return;
  }
  resetProductForm();
  wizardPendingPhoto = {
    id: String(media.id),
    original_filename: media.original_filename || 'Fotografía',
    adminUrl: media.adminUrl,
    classified: false,
  };
  renderWizardMedia(null);
  showProductEditor();
}

async function deletePendingPhoto(media, button) {
  if (!window.confirm(`¿Eliminar “${media.original_filename || 'esta fotografía'}” de forma permanente?`)) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/media/${encodeURIComponent(media.id)}`, { method: 'DELETE' });
    await Promise.all([loadPhotoInbox(), loadImageLibrary()]);
    photoInboxStatus.textContent = result.message || 'Se eliminó la fotografía pendiente.';
    photoInboxStatus.dataset.state = result.warning ? 'error' : 'success';
    showNotification(photoInboxStatus.textContent, { type: result.warning ? 'error' : 'success' });
  } catch (error) {
    photoInboxStatus.textContent = error.message;
    photoInboxStatus.dataset.state = 'error';
    showNotification(error.message, { type: 'error' });
    button.disabled = false;
  }
}

async function uploadSelectedPhotos(retryOnly = false) {
  if (photoUploadInProgress) return;
  if (selectedPhotoFiles.length > photoMaxBatchFiles) {
    photoUploadStatus.textContent = `Seleccionaste ${selectedPhotoFiles.length} fotografías. Divide la selección en lotes de hasta ${photoMaxBatchFiles}.`;
    photoUploadStatus.dataset.state = 'error';
    return;
  }
  const entries = selectedPhotoFiles.filter((entry) => !entry.mediaId && !entry.formatRejected
    && entry.file.size > 0 && entry.file.size <= photoMaxFileBytes
    && (retryOnly ? entry.status.startsWith('Error:') : !entry.status.startsWith('Error:')));
  if (!entries.length) return;
  if (entries.length > photoMaxBatchFiles) {
    photoUploadStatus.textContent = `El lote admite hasta ${photoMaxBatchFiles} fotografías. Quita algunos archivos y vuelve a intentarlo.`;
    photoUploadStatus.dataset.state = 'error';
    return;
  }
  photoUploadInProgress = true;
  renderSelectedPhotoFiles();
  if (!photoUploadBatchId) photoUploadBatchId = crypto.randomUUID();
  let uploaded = 0;
  let failed = 0;
  let duplicates = 0;
  for (const [index, entry] of entries.entries()) {
    entry.status = `Subiendo ${index + 1} de ${entries.length}…`;
    renderSelectedPhotoFiles();
    try {
      const response = await fetch(`/api/admin/media/upload/${photoUploadBatchId}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'X-CSRF-Token': csrfToken,
          'X-Original-Filename': encodeURIComponent(entry.file.name),
        },
        body: entry.file,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.assign('/admin/login');
        throw new Error('La sesión terminó. Inicia sesión nuevamente.');
      }
      if (!response.ok) throw new Error(result.error || 'No se pudo cargar esta fotografía.');
      if (!result.media?.id) throw new Error('El servidor no confirmó el archivo. Puedes volver a intentarlo.');
      entry.mediaId = String(result.media.id);
      if (result.duplicate) {
        duplicates += 1;
        entry.status = result.media.classification_status === 'pending'
          ? 'Ya estaba guardada · pendiente de clasificación'
          : 'Ya estaba asignada · no se duplicó';
      } else {
        entry.status = 'Guardada · pendiente de clasificación';
      }
      uploaded += 1;
    } catch (error) {
      entry.status = `Error: ${error.message}`;
      failed += 1;
    }
    renderSelectedPhotoFiles();
  }
  photoUploadInProgress = false;
  const remainingFailures = selectedPhotoFiles.some((entry) => entry.status.startsWith('Error:'));
  if (!remainingFailures) photoUploadBatchId = null;
  renderSelectedPhotoFiles();
  const rejected = selectedPhotoFiles.filter((entry) => !entry.mediaId
    && (entry.formatRejected || entry.file.size === 0 || entry.file.size > photoMaxFileBytes)).length;
  photoUploadStatus.textContent = `${uploaded} confirmadas${duplicates ? ` · ${duplicates} ya existían y no se duplicaron` : ''}${failed ? ` · ${failed} con error; puedes volver a intentar las fallidas` : ''}${rejected ? ` · ${rejected} no admitidas; retíralas o corrige el archivo` : ''}. Las fotografías nuevas siguen privadas hasta clasificarlas.`;
  photoUploadStatus.dataset.state = failed || rejected ? 'error' : 'success';
  document.querySelector('#photo-upload-summary').textContent = `${uploaded} confirmadas en este intento${duplicates ? ` · ${duplicates} ya estaban guardadas y no se duplicaron` : ''}${failed ? ` · ${failed} fallidas; reintenta solo esas fotografías` : ''}${rejected ? ` · ${rejected} archivos no admitidos` : ''}. Las fotografías nuevas siguen privadas y pendientes de clasificación.`;
  document.querySelector('#photo-upload-summary').hidden = false;
  document.querySelector('#photo-upload-return').hidden = false;
  document.querySelector('#photo-upload-next-batch').hidden = remainingFailures || selectedPhotoFiles.length === 0;
  await loadPhotoInbox();
  await loadImageLibrary();
}

async function loadData() {
  const [categoryResult, productResult] = await Promise.allSettled([
    api('/api/admin/categories'),
    api('/api/admin/products'),
  ]);
  const errors = [];
  if (productResult.status === 'fulfilled') {
    currentProducts = productResult.value.products;
    if (Number.isSafeInteger(productResult.value.maxVideoFileBytes) && productResult.value.maxVideoFileBytes > 0) {
      wizardMaxVideoFileBytes = productResult.value.maxVideoFileBytes;
      document.querySelector('#wizard-video-help').textContent = `Formatos MP4 o WebM, hasta ${formatMediaSize(wizardMaxVideoFileBytes)}. El video se reproduce bajo demanda en los detalles públicos.`;
    }
    renderProducts(currentProducts);
  } else {
    currentProducts = null;
    errors.push(productResult.reason.message);
  }
  if (categoryResult.status === 'fulfilled') {
    renderCategories(categoryResult.value.categories, currentProducts);
  } else {
    errors.push(categoryResult.reason.message);
    setWizardCategoryLoadError(categoryResult.reason.message);
  }
  await Promise.all([loadPhotoInbox(), loadImageLibrary()]);
  setStatus(errors.length ? errors.join(' ') : 'Tus productos están al día.', errors.length > 0);
  return errors.length === 0;
}

async function changePublication(product, shouldPublish) {
  const action = shouldPublish ? 'publicar' : 'despublicar';
  if (shouldPublish && !window.confirm(`¿Publicar “${product.name}” en el catálogo público?`)) return;
  try {
    const result = await api(`/api/admin/products/${encodeURIComponent(product.id)}/${shouldPublish ? 'publish' : 'unpublish'}`, {
      method: 'POST',
      body: '{}',
    });
    setStatus(result.message);
    await loadData();
  } catch (error) {
    setStatus(`No se pudo ${action} el trabajo: ${error.message}`, true);
  }
}

function deleteProduct(product) {
  openProductDeleteDialog(product);
}

async function performProductDeletion(product) {
  let result;
  try {
    result = await api(`/api/admin/products/${encodeURIComponent(String(product.id))}`, {
      method: 'DELETE',
    });
  } catch (error) {
    setStatus(error.message || 'No se pudo eliminar el trabajo.', true);
    return;
  }

  const [productResult, categoryResult] = await Promise.allSettled([
    api('/api/admin/products'),
    api('/api/admin/categories'),
  ]);

  if (productResult.status === 'fulfilled') {
    currentProducts = productResult.value.products;
    renderProducts(currentProducts);
  } else {
    currentProducts = null;
  }
  if (categoryResult.status === 'fulfilled') {
    renderCategories(categoryResult.value.categories, currentProducts);
  }

  if (productResult.status === 'rejected') {
    setStatus('El servidor aceptó la eliminación, pero no se pudo comprobar si el trabajo ya no existe. Recarga el panel para verificarlo.', true);
    return;
  }
  if (productResult.value.products.some((item) => String(item.id) === String(product.id))) {
    setStatus('El trabajo todavía aparece en la consulta del servidor; no se confirmó su eliminación.', true);
    return;
  }
  if (categoryResult.status === 'rejected') {
    setStatus('El trabajo ya no aparece en la consulta del servidor, pero no se pudieron actualizar las dependencias de categorías. Recarga el panel.', true);
    return;
  }

  setStatus(result.message || `Trabajo “${product.name}” eliminado.`);
}

async function deleteCategory(category) {
  const linkedProducts = Array.isArray(currentProducts)
    ? currentProducts.filter((product) => String(product.category_id ?? '') === String(category.id))
    : [];
  const childCategories = currentCategories.filter((candidate) => String(candidate.parent_id ?? '') === String(category.id));
  const hasMeasurementTemplate = category.measurement_template !== null && category.measurement_template !== undefined;
  const hasPricingRules = category.pricing_rules !== null && category.pricing_rules !== undefined;
  if (currentProducts === null) {
    openCategoryDependencies(category.id);
    setStatus('No se pudo comprobar si hay trabajos asociados. Recarga el panel para actualizar las dependencias antes de eliminar.', true);
    return;
  }
  const blockers = [
    ...(linkedProducts.length ? [`${linkedProducts.length} ${linkedProducts.length === 1 ? 'trabajo' : 'trabajos'}`] : []),
    ...(childCategories.length ? [`${childCategories.length} ${childCategories.length === 1 ? 'subcategoría' : 'subcategorías'}`] : []),
    ...(hasMeasurementTemplate ? ['una plantilla de medidas'] : []),
    ...(hasPricingRules ? ['una regla de precio'] : []),
  ];
  if (blockers.length) {
    openCategoryDependencies(category.id);
    setStatus(`No se puede eliminar “${category.name}”: tiene ${blockers.join(', ')}. Revisa “Ver dependencias” en la tarjeta y gestiona cada elemento antes de volver a intentarlo.`, true);
    return;
  }

  const confirmed = window.confirm(
    `¿Eliminar la categoría “${category.name}”? No tiene dependencias conocidas y no se borrarán trabajos ni otros datos asociados.`,
  );
  if (!confirmed) return;

  const categoryId = String(category.id);
  let result;
  try {
    result = await api(`/api/admin/categories/${encodeURIComponent(categoryId)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (error.status === 409) {
      await loadData();
      openCategoryDependencies(category.id);
    }
    setStatus(error.message || 'No se pudo eliminar la categoría.', true);
    return;
  }

  if (document.querySelector('#category-id').value === categoryId) resetCategoryForm();
  try {
    const categoryResult = await api('/api/admin/categories');
    renderCategories(categoryResult.categories, currentProducts);
    if (categoryResult.categories.some((item) => String(item.id) === categoryId)) {
      setStatus('El servidor respondió a la solicitud, pero la categoría todavía aparece al volver a consultarla. No se pudo confirmar su eliminación.', true);
      return;
    }
    setStatus(result.message || 'Categoría eliminada.');
  } catch (error) {
    setStatus(`La solicitud de eliminación fue aceptada, pero no se pudo confirmar al actualizar la lista. Recarga la página para comprobar el estado. ${error.message}`, true);
  }
}

async function saveCategory(payload, { id = '', selectForProduct = false } = {}) {
  try {
    const result = await api(id ? `/api/admin/categories/${encodeURIComponent(id)}` : '/api/admin/categories', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    setStatus(result.message);
    await loadData();
    if (id) resetCategoryForm();
    if (selectForProduct && result.category?.id) {
      const categoryId = String(result.category.id);
      if (!categoriesById.has(categoryId)) renderCategories([...currentCategories, result.category], currentProducts);
      const categorySelect = document.querySelector('#product-category');
      categorySelect.value = categoryId;
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#wizard-category-list').hidden = false;
      document.querySelector('#wizard-show-categories').setAttribute('aria-expanded', 'true');
      document.querySelector('#wizard-retry-categories').hidden = true;
      document.querySelector('#wizard-category-load-status').textContent = `${currentCategories.length} ${currentCategories.length === 1 ? 'categoría disponible' : 'categorías disponibles'}.`;
      document.querySelector('#wizard-category-load-status').dataset.state = 'success';
      document.querySelector('#wizard-new-category-name').value = '';
      document.querySelector('#wizard-new-category-panel').hidden = true;
      const status = document.querySelector('#wizard-category-status');
      status.textContent = 'Categoría guardada y seleccionada.';
      status.dataset.state = 'success';
    }
    return result;
  } catch (error) {
    setStatus(error.message, true);
    if (selectForProduct) {
      const status = document.querySelector('#wizard-category-status');
      status.textContent = error.message || 'No se pudo guardar la categoría. Revisa el nombre e inténtalo de nuevo.';
      status.dataset.state = 'error';
    }
    return null;
  }
}

categoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = document.querySelector('#category-id').value;
  try {
    await saveCategory({
      name: document.querySelector('#category-name').value,
      slug: document.querySelector('#category-slug').value,
      description: document.querySelector('#category-description').value,
      measurementTemplate: collectMeasurementConfig('category-template-dimensions'),
      isActive: document.querySelector('#category-active').checked,
    }, { id });
  } catch (error) {
    setStatus(error.message, true);
  }
});

productForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentWizardStep !== 5) {
    goToNextWizardStep();
    return;
  }
  if (wizardSaveInProgress) return;
  const nameInput = document.querySelector('#product-name');
  if (!nameInput.value.trim()) {
    setWizardStep(1);
    nameInput.setCustomValidity('Escribe el nombre del mueble para continuar.');
    nameInput.reportValidity();
    return;
  }
  nameInput.setCustomValidity('');
  const categoryId = document.querySelector('#product-category').value;
  if (!categoryId || !categoriesById.has(String(categoryId))) {
    setWizardStep(2);
    const categoryStatus = document.querySelector('#wizard-category-status');
    categoryStatus.textContent = 'Selecciona una categoría válida antes de guardar.';
    categoryStatus.dataset.state = 'error';
    setStatus(categoryStatus.textContent, true);
    return;
  }
  if (wizardPhotoUploadInProgress || wizardPhotoFiles.some((entry) => !entry.media)) {
    setWizardStep(3);
    setStatus(wizardPhotoUploadInProgress
      ? 'Espera a que termine la carga de las fotografías.'
      : 'Sube o quita las fotografías pendientes antes de guardar.', true);
    return;
  }
  try {
    collectMeasurementConfig('product-dimensions');
    if (!fixedDimensionsFormatUnknown) collectFixedDimensions();
  } catch (error) {
    setWizardStep(4);
    setStatus(error.message, true);
    return;
  }
  const shouldPublish = event.submitter?.dataset.saveMode === 'publish';
  if (shouldPublish && !window.confirm('¿Guardar y mostrar este producto en tu tienda?')) return;
  const saveButtons = [document.querySelector('#save-draft-button'), document.querySelector('#save-publish-button')];
  const originalSaveButtonLabels = saveButtons.map((button) => button.textContent);
  const activeSaveButton = shouldPublish ? saveButtons[1] : saveButtons[0];
  wizardSaveInProgress = true;
  saveButtons.forEach((button) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  });
  activeSaveButton.textContent = shouldPublish ? 'Publicando…' : 'Guardando…';
  let productSaved = false;
  try {
    const id = document.querySelector('#product-id').value;
    const result = await api(id ? `/api/admin/products/${encodeURIComponent(id)}` : '/api/admin/products', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        name: document.querySelector('#product-name').value,
        slug: document.querySelector('#product-slug').value,
        description: document.querySelector('#product-description').value,
        categoryId: document.querySelector('#product-category').value,
        measurementConfig: collectMeasurementConfig('product-dimensions'),
        ...(!fixedDimensionsFormatUnknown ? { fixedDimensions: collectFixedDimensions() } : {}),
      }),
    });
    const savedId = id || result.product?.id;
    if (!savedId) throw new Error('El servidor no confirmó el identificador del mueble guardado. La información permanece en el formulario.');
    productSaved = true;
    document.querySelector('#product-id').value = String(savedId);
    await saveWizardGallery(savedId);
    await saveWizardVideo(savedId);
    let completionMessage = result.message || 'Mueble guardado.';
    if (shouldPublish && savedId) {
      const publication = await api(`/api/admin/products/${encodeURIComponent(savedId)}/publish`, {
        method: 'POST',
        body: '{}',
      });
      completionMessage = publication.message;
    } else if (editingProduct?.is_published) {
      completionMessage = 'Cambios guardados. El mueble sigue publicado.';
    }
    const refreshed = await loadData();
    if (!refreshed) completionMessage += ' No se pudo actualizar por completo la lista del panel; recárgala para ver el estado más reciente.';
    productForm.hidden = true;
    document.querySelector('#product-save-result-message').textContent = completionMessage;
    document.querySelector('#product-save-result').hidden = false;
    setStatus(completionMessage, !refreshed);
    showNotification(completionMessage, { type: refreshed ? 'success' : 'error' });
  } catch (error) {
    const message = productSaved
      ? `El mueble quedó guardado, pero no se pudo completar la operación de fotografías, video o publicación. ${error.message} Tus datos siguen en el asistente; puedes corregirlo y volver a guardar.`
      : error.message;
    setStatus(message, true);
    showNotification(message, { type: 'error' });
  } finally {
    wizardSaveInProgress = false;
    saveButtons.forEach((button, index) => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalSaveButtonLabels[index];
    });
  }
});

function goToNextWizardStep() {
  try {
    if (currentWizardStep === 1) {
      const name = document.querySelector('#product-name');
      if (!name.reportValidity()) return;
    }
    if (currentWizardStep === 2 && !document.querySelector('#product-category').value) {
      const firstRadio = document.querySelector('#wizard-category-list input[type="radio"]');
      const message = currentCategories.length
        ? 'Selecciona una categoría para continuar.'
        : 'Crea una categoría para poder continuar.';
      document.querySelector('#wizard-category-status').textContent = message;
      document.querySelector('#wizard-category-status').dataset.state = 'error';
      setStatus(message, true);
      (firstRadio ?? document.querySelector('#wizard-toggle-category')).focus();
      return;
    }
    if (currentWizardStep === 3) {
      if (wizardPhotoUploadInProgress) {
        setStatus('Espera a que termine la carga de las fotografías.', true);
        return;
      }
      const pending = wizardPhotoFiles.filter((entry) => !entry.media);
      if (pending.length) {
        const retry = pending.some((entry) => entry.status.startsWith('Error:'));
        const message = retry
          ? 'Reintenta las fotografías que fallaron o quítalas antes de continuar.'
          : 'Sube las fotografías seleccionadas o quítalas antes de continuar.';
        document.querySelector('#wizard-photo-status').textContent = message;
        document.querySelector('#wizard-photo-status').dataset.state = 'error';
        setStatus(message, true);
        (retry ? document.querySelector('#wizard-photo-retry') : document.querySelector('#wizard-photo-upload')).focus();
        return;
      }
      const invalidVideo = wizardSelectedVideos.map((file) => ({ file, error: validateWizardVideoFile(file) })).find((entry) => entry.error);
      if (invalidVideo) {
        const videoError = invalidVideo.error;
        document.querySelector('#wizard-video-status').textContent = `${invalidVideo.file.name}: ${videoError}`;
        document.querySelector('#wizard-video-status').dataset.state = 'error';
        document.querySelector('#wizard-video-file').focus();
        return;
      }
    }
    if (currentWizardStep === 4) {
      collectMeasurementConfig('product-dimensions');
      if (!fixedDimensionsFormatUnknown) collectFixedDimensions();
    }
    setWizardStep(currentWizardStep + 1);
  } catch (error) {
    setStatus(error.message, true);
  }
}

document.querySelector('#wizard-next').addEventListener('click', goToNextWizardStep);
document.querySelector('#wizard-previous').addEventListener('click', () => setWizardStep(currentWizardStep - 1));
document.querySelector('#wizard-show-categories').addEventListener('click', loadWizardCategories);
document.querySelector('#wizard-retry-categories').addEventListener('click', loadWizardCategories);
document.querySelectorAll('[data-review-step]').forEach((button) => {
  button.addEventListener('click', () => setWizardStep(Number(button.dataset.reviewStep)));
});
document.querySelector('#wizard-toggle-category').addEventListener('click', () => {
  const panel = document.querySelector('#wizard-new-category-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) document.querySelector('#wizard-new-category-name').focus();
});
document.querySelector('#wizard-cancel-category').addEventListener('click', () => {
  document.querySelector('#wizard-new-category-panel').hidden = true;
  document.querySelector('#wizard-new-category-name').value = '';
  document.querySelector('#wizard-category-status').textContent = '';
  document.querySelector('#wizard-toggle-category').focus();
});
document.querySelector('#wizard-save-category').addEventListener('click', async (event) => {
  if (quickCreateCategoryRequested) return;
  const name = document.querySelector('#wizard-new-category-name').value.trim();
  const status = document.querySelector('#wizard-category-status');
  const button = event.currentTarget;
  if (!name) {
    status.textContent = 'Escribe el nombre de la categoría.';
    status.dataset.state = 'error';
    document.querySelector('#wizard-new-category-name').focus();
    return;
  }
  const slug = toSlug(name);
  if (!slug) {
    status.textContent = 'Escribe un nombre con letras o números para crear la categoría.';
    status.dataset.state = 'error';
    document.querySelector('#wizard-new-category-name').focus();
    return;
  }
  quickCreateCategoryRequested = true;
  button.disabled = true;
  status.textContent = 'Guardando categoría…';
  status.dataset.state = 'loading';
  await saveCategory({
    name,
    slug,
    description: '',
    measurementTemplate: null,
    isActive: true,
  }, { selectForProduct: true });
  quickCreateCategoryRequested = false;
  button.disabled = false;
});
document.querySelector('#wizard-photo-files').addEventListener('change', (event) => {
  addWizardPhotoFiles([...event.target.files]);
  event.target.value = '';
});
document.querySelector('#wizard-video-file').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  const status = document.querySelector('#wizard-video-status');
  const invalid = files.map((file) => ({ file, error: validateWizardVideoFile(file) })).filter((entry) => entry.error);
  if (invalid.length) {
    status.textContent = invalid.map(({ file, error }) => `${file.name}: ${error}`).join(' ');
    status.dataset.state = 'error';
    showNotification('Uno o más videos no cumplen con los formatos o límites permitidos.', { type: 'error' });
  }
  wizardSelectedVideos.push(...files.filter((file) => !invalid.some((entry) => entry.file === file)));
  if (!invalid.length) {
    status.textContent = `${files.length} video${files.length === 1 ? '' : 's'} listo${files.length === 1 ? '' : 's'} para guardar con el trabajo.`;
    status.dataset.state = 'success';
  }
  renderWizardVideo();
  if (currentWizardStep === 5) renderProductReview();
});
const wizardPhotoDropzone = document.querySelector('#wizard-photo-dropzone');
for (const eventName of ['dragenter', 'dragover']) {
  wizardPhotoDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    wizardPhotoDropzone.classList.add('is-dragging');
  });
}
wizardPhotoDropzone.addEventListener('dragleave', (event) => {
  if (!wizardPhotoDropzone.contains(event.relatedTarget)) wizardPhotoDropzone.classList.remove('is-dragging');
});
wizardPhotoDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  wizardPhotoDropzone.classList.remove('is-dragging');
  if (event.dataTransfer?.files.length) addWizardPhotoFiles([...event.dataTransfer.files]);
});
document.querySelector('#wizard-photo-upload').addEventListener('click', () => uploadWizardPhotos());
document.querySelector('#wizard-photo-retry').addEventListener('click', () => uploadWizardPhotos(true));
document.querySelector('#return-to-products').addEventListener('click', () => {
  resetProductForm();
  navigateAdminView('products-section', { focus: true });
});
document.querySelector('#add-another-product').addEventListener('click', () => {
  resetProductForm();
  showProductEditor();
});
document.querySelector('#add-product-dimension').addEventListener('click', () => {
  addMeasurement('product-dimensions', document.querySelector('#product-dimension-type').value, () => { productMeasurementsTouched = true; });
});
document.querySelector('#add-template-dimension').addEventListener('click', () => {
  addMeasurement('category-template-dimensions', document.querySelector('#template-dimension-type').value);
});
document.querySelector('#add-fixed-dimension').addEventListener('click', addFixedDimension);
document.querySelector('#apply-category-template').addEventListener('click', () => applyCategoryTemplate());
document.querySelector('#product-category').addEventListener('change', handleProductCategoryChange);
for (const control of document.querySelectorAll('[data-start-wizard]')) {
  control.addEventListener('click', (event) => {
    event.preventDefault();
    resetProductForm();
    showProductEditor();
  });
}
document.querySelector('[data-show-products]').addEventListener('click', (event) => {
  event.preventDefault();
  navigateAdminView('products-section', { focus: true });
});
productSearchInput.addEventListener('input', () => {
  if (Array.isArray(currentProducts)) renderProducts(currentProducts);
});
productStatusFilter.addEventListener('change', () => {
  if (Array.isArray(currentProducts)) renderProducts(currentProducts);
});
document.querySelector('[data-open-categories]').addEventListener('click', (event) => {
  event.preventDefault();
  navigateAdminView('category-management');
  requestAnimationFrame(() => document.querySelector('#category-name').focus());
});

for (const link of adminNavigationLinks) {
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateAdminView(link.hash.slice(1), { focus: true });
  });
}

document.querySelector('#photo-upload-return').addEventListener('click', (event) => {
  event.preventDefault();
  navigateAdminView('photo-inbox', { focus: true });
});

window.addEventListener('hashchange', syncAdminViewFromLocation);
window.addEventListener('popstate', syncAdminViewFromLocation);
syncAdminViewFromLocation();

document.querySelector('#category-name').addEventListener('input', (event) => {
  if (!categorySlugEdited) document.querySelector('#category-slug').value = toSlug(event.target.value);
});
document.querySelector('#category-slug').addEventListener('input', () => { categorySlugEdited = true; });
document.querySelector('#product-name').addEventListener('input', (event) => {
  event.target.setCustomValidity('');
  if (!productSlugEdited) document.querySelector('#product-slug').value = toSlug(event.target.value);
});
document.querySelector('#product-slug').addEventListener('input', () => { productSlugEdited = true; });
document.querySelector('#cancel-category-edit').addEventListener('click', resetCategoryForm);
document.querySelector('#cancel-product-edit').addEventListener('click', resetProductForm);
document.querySelector('#logout-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Cerrando sesión…';
  try {
    const response = await fetch('/admin/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (!response.ok) throw new Error('No fue posible cerrar la sesión.');
    window.location.assign('/admin/login');
  } catch {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    setStatus('No fue posible cerrar la sesión. Vuelve a intentarlo.', true);
    showNotification('No fue posible cerrar la sesión. Vuelve a intentarlo.', { type: 'error' });
  }
});

document.querySelector('#revoke-sessions-button').addEventListener('click', async (event) => {
  if (!window.confirm('Se cerrarán todas las sesiones administrativas. Tendrás que iniciar sesión de nuevo. ¿Continuar?')) return;
  const button = event.currentTarget;
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Cerrando sesiones…';
  try {
    await api('/api/admin/sessions/revoke', { method: 'POST', body: '{}' });
    window.location.assign('/admin/login');
  } catch (error) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    setStatus(error.message || 'No fue posible revocar las sesiones.', true);
    showNotification(error.message || 'No fue posible revocar las sesiones.', { type: 'error' });
  }
});

function addSelectedPhotoFiles(files) {
  const incoming = [...files];
  if (selectedPhotoFiles.some((entry) => entry.mediaId || entry.status.startsWith('Error:'))) {
    photoUploadStatus.textContent = 'Termina o retira los archivos de este lote antes de seleccionar otro. Las fotografías guardadas ya no se volverán a subir.';
    photoUploadStatus.dataset.state = 'error';
    return;
  }
  if (selectedPhotoFiles.length + incoming.length > photoMaxBatchFiles) {
    photoUploadStatus.textContent = `Esta selección suma ${selectedPhotoFiles.length + incoming.length} fotografías. Divide los archivos en lotes de hasta ${photoMaxBatchFiles}; no se inició ninguna carga.`;
    photoUploadStatus.dataset.state = 'error';
    return;
  }
  const existingKeys = new Set(selectedPhotoFiles.map((entry) => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`));
  for (const file of incoming) {
    const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingKeys.has(fileKey)) continue;
    existingKeys.add(fileKey);
    const extensionAllowed = /\.(?:jpe?g|png|webp)$/i.test(file.name);
    const formatRejected = file.type
      ? !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      : !extensionAllowed;
    const status = formatRejected
      ? 'Formato no admitido; usa JPG, PNG o WebP'
      : file.size === 0
        ? 'El archivo está vacío'
        : file.size > photoMaxFileBytes
      ? `Supera el límite de ${Math.ceil(photoMaxFileBytes / (1024 * 1024))} MB`
      : 'Lista para cargar';
    const entry = { id: crypto.randomUUID(), file, status, formatRejected };
    selectedPhotoFiles.push(entry);
  }
  renderSelectedPhotoFiles();
  if (selectedPhotoFiles.some((entry) => entry.formatRejected)) {
    photoUploadStatus.textContent = 'Hay archivos con un formato no admitido. Retíralos antes de continuar.';
    photoUploadStatus.dataset.state = 'error';
  }
}

document.querySelector('#photo-files').addEventListener('change', (event) => {
  addSelectedPhotoFiles([...event.target.files]);
  event.target.value = '';
});

const photoDropzone = document.querySelector('#photo-dropzone');
for (const eventName of ['dragenter', 'dragover']) {
  photoDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    photoDropzone.classList.add('is-dragging');
  });
}
photoDropzone.addEventListener('dragleave', (event) => {
  if (!photoDropzone.contains(event.relatedTarget)) photoDropzone.classList.remove('is-dragging');
});
photoDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  photoDropzone.classList.remove('is-dragging');
  if (document.querySelector('#photo-files').disabled) return;
  if (event.dataTransfer?.files.length) addSelectedPhotoFiles([...event.dataTransfer.files]);
});

document.querySelector('#photo-upload-button').addEventListener('click', () => uploadSelectedPhotos(false));
document.querySelector('#photo-upload-retry').addEventListener('click', () => uploadSelectedPhotos(true));
document.querySelector('#photo-upload-next-batch').addEventListener('click', () => {
  if (photoUploadInProgress || selectedPhotoFiles.some((entry) => entry.status.startsWith('Error:'))) return;
  selectedPhotoFiles.length = 0;
  photoUploadBatchId = null;
  document.querySelector('#photo-upload-summary').hidden = true;
  document.querySelector('#photo-upload-next-batch').hidden = true;
  photoUploadStatus.textContent = '';
  photoUploadStatus.dataset.state = '';
  renderSelectedPhotoFiles();
  document.querySelector('#photo-dropzone').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#photo-search-button').addEventListener('click', () => {
  photoSearchTerm = document.querySelector('#photo-search').value.trim();
  photoPage = 1;
  loadPhotoInbox();
});
document.querySelector('#photo-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  document.querySelector('#photo-search-button').click();
});
document.querySelector('#photo-page-previous').addEventListener('click', () => {
  if (photoPage <= 1) return;
  photoPage -= 1;
  loadPhotoInbox();
});
document.querySelector('#photo-page-next').addEventListener('click', () => {
  if (photoPage >= photoPageCount) return;
  photoPage += 1;
  loadPhotoInbox();
});
document.querySelector('#image-library-search-button').addEventListener('click', () => {
  imageLibrarySearchTerm = document.querySelector('#image-library-search').value.trim();
  imageLibraryPage = 1;
  loadImageLibrary();
});
document.querySelector('#image-library-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  document.querySelector('#image-library-search-button').click();
});
document.querySelector('#image-library-previous').addEventListener('click', () => {
  if (imageLibraryPage <= 1) return;
  imageLibraryPage -= 1;
  loadImageLibrary();
});
document.querySelector('#image-library-next').addEventListener('click', () => {
  if (imageLibraryPage >= imageLibraryPageCount) return;
  imageLibraryPage += 1;
  loadImageLibrary();
});
loadData();
