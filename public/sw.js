/* pr.radiator — minimal SW so notification clicks can open+focus a tab.
   Page-level Notification.onclick cannot reliably focus a new tab (browser policy).
   clients.openWindow() from notificationclick is the supported path. */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url;
  if (!targetUrl || typeof targetUrl !== 'string') return;

  event.waitUntil(
    clients.openWindow(targetUrl).catch((error) => {
      console.warn('[pr.radiator sw] openWindow failed', error);
    })
  );
});
