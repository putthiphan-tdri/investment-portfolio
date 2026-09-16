(() => {
  const installButton = document.querySelector('#installAppButton');
  const installDialog = document.querySelector('#installDialog');
  const nativeInstallButton = document.querySelector('#nativeInstallButton');
  const availability = document.querySelector('#installAvailability');
  const offlineNotice = document.querySelector('#offlineNotice');
  const updateNotice = document.querySelector('#updateNotice');
  const displayMode = window.matchMedia('(display-mode: standalone)');
  let installPrompt = null;
  let registration = null;
  let applyingUpdate = false;

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

  document.querySelector('#applyUpdateButton').addEventListener('click', () => {
    if (!registration?.waiting) return;
    // Leave open forms intact; another window also gets the new version on its next launch.
    if (document.querySelector('dialog[open]')) {
      updateNotice.querySelector('span').textContent = 'Finish and close the open form, then reload to update.';
      return;
    }
    applyingUpdate = true;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applyingUpdate) window.location.reload();
  });

  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((result) => {
    registration = result;
    const showUpdate = () => {
      updateNotice.hidden = !(registration.waiting && navigator.serviceWorker.controller);
    };
    showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', showUpdate);
    });
    // Dock windows can remain open for days; check again when they regain focus.
    window.addEventListener('focus', () => {
      if (navigator.onLine) registration.update().catch(() => {});
    });
  }).catch(() => {
    availability.textContent = 'Offline setup could not finish. Reconnect and reload the app before relying on offline access.';
  });
})();
