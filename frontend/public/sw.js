self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "FlashFix TX", body: event.data?.text() || "New notification" };
  }

  const title = payload.title || "FlashFix TX";
  const options = {
    body: payload.body || "You have a FlashFix update.",
    tag: payload.tag || "flashfix-notification",
    data: { url: payload.url || "/" },
    icon: "/apple-touch-icon.png",
    badge: "/apple-touch-icon.png"
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
