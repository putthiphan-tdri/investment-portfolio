(() => {
  const installButton = document.querySelector('#installAppButton');
  const installDialog = document.querySelector('#installDialog');
  const nativeInstallButton = document.querySelector('#nativeInstallButton');
  const availability = document.querySelector('#installAvailability');
  const offlineNotice = document.querySelector('#offlineNotice');
  const updateNotice = document.querySelector('#updateNotice');
  const applyUpdateButton = document.querySelector('#applyUpdateButton');
  // Read the version of this loaded page, not a potentially newer network response.
  const pageVersion = new URL(document.currentScript.src).searchParams.get('v');
  const workerVersions = new WeakMap();
  const displayMode = window.matchMedia('(display-mode: standalone)');
  let installPrompt = null;
  let registration = null;
  let applyingUpdate = false;
  let reloading = false;
  let updateCheck = 0;

  function getWorkerVersion(worker) {
    if (!workerVersions.has(worker)) {
      workerVersions.set(worker, new Promise((resolve) => {
        const channel = new MessageChannel();
        const finish = (version) => {
          window.clearTimeout(timeout);
          channel.port1.close();
          resolve(version);
        };
        // Older workers do not implement GET_VERSION; they still need an upgrade path.
        const timeout = window.setTimeout(() => finish(null), 1500);
        channel.port1.onmessage = (event) => finish(event.data?.version || null);
        try {
          worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
        } catch {
          finish(null);
        }
      }));
    }
    return workerVersions.get(worker);
  }

  async function showUpdate() {
    const check = ++updateCheck;
    const worker = registration?.waiting;
    if (applyingUpdate || !worker || worker.state !== 'installed' ||
        !navigator.serviceWorker.controller || worker === navigator.serviceWorker.controller) {
      updateNotice.hidden = true;
      return null;
    }
    const version = await getWorkerVersion(worker);
    // A delayed reply must not restore a notice after activation or replacement.
    if (check !== updateCheck || registration.waiting !== worker ||
        worker.state !== 'installed' || applyingUpdate) return null;
    updateNotice.hidden = !!(version && pageVersion && version === pageVersion);
    return updateNotice.hidden ? null : worker;
  }

  function updateInstallButton() {
    installButton.hidden = displayMode.matches || navigator.standalone === true;
  }

  function updateConnection() {
    offlineNotice.hidden = navigator.onLine;
  }

  updateInstallButton();
  updateConnection();
  displayMode.addEventListener('change', updateInstallButton);
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  installButton.addEventListener('click', () => installDialog.showModal());

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    nativeInstallButton.hidden = false;
  });

  nativeInstallButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    nativeInstallButton.hidden = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') installDialog.close();
    } catch {
      availability.textContent = 'Use your browser’s install app menu, or Safari’s File → Add to Dock.';
    }
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    nativeInstallButton.hidden = true;
    installButton.hidden = true;
    installDialog.close();
  });

  if (!window.isSecureContext || !('serviceWorker' in navigator) || location.protocol === 'file:') {
    availability.textContent = 'Offline setup needs a supported browser and an HTTPS website or localhost server. Open My Funds there before installing.';
    return;
  }

  applyUpdateButton.addEventListener('click', async () => {
    if (applyingUpdate) return;
    // Leave open forms intact; another window also gets the new version on its next launch.
    if (document.querySelector('dialog[open]')) {
      updateNotice.querySelector('span').textContent = 'Finish and close the open form, then reload to update.';
      return;
    }
    const worker = await showUpdate();
    if (!worker || applyingUpdate) return;
    applyingUpdate = true;
    applyUpdateButton.disabled = true;
    updateNotice.hidden = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
    // If activation fails, allow a deliberate retry rather than a dead button.
    window.setTimeout(() => {
      if (reloading) return;
      applyingUpdate = false;
      applyUpdateButton.disabled = false;
      showUpdate();
    }, 10000);
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applyingUpdate && !reloading) {
      reloading = true;
      window.location.reload();
    } else {
      showUpdate();
    }
  });

  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((result) => {
    registration = result;
    showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        // Safari may populate registration.waiting after the statechange event.
        window.setTimeout(showUpdate, 0);
      });
    });
    window.setInterval(showUpdate, 1000);
    // Dock windows can remain open for days; check again when they regain focus.
    window.addEventListener('focus', () => {
      showUpdate();
      if (navigator.onLine) registration.update().then(showUpdate).catch(() => {});
    });
  }).catch(() => {
    availability.textContent = 'Offline setup could not finish. Reconnect and reload the app before relying on offline access.';
  });
})();
