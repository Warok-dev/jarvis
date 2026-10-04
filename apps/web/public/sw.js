// Service worker de Jarvis. Les gestionnaires « push » et « notificationclick »
// arrivent à l'étape des notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
