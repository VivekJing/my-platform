Steedos.pushSpace = new SubsManager();

Steedos.isElectron = function() {
  return Steedos.isNode() && nw.ipcRenderer;
};

Steedos.isNewWindow = function() {
  if (Steedos.isNode()) {
    if (Steedos.isElectron() && window.opener) {
      return true;
    } else if (window.opener && window.opener.opener) {
      return true;
    }
  } else if (window.opener) {
    return true;
  }
};

Tracker.autorun(function(c) {
  return Steedos.pushSpace.subscribe("raix_push_notifications");
});

if (!Steedos.isMobile()) {
  Steedos.Push = require("push.js");
}

Steedos.playNodeBadge = function(badgeCount) {
  if (Steedos.isNode()) {
    if (nw.ipcRenderer) {
      if (!badgeCount) {
        badgeCount = 0;
      }
      return nw.ipcRenderer.sendToHost('onBadgeChange', false, 0, badgeCount, false, false);
    } else {
      return nw.Window.get().requestAttention(3);
    }
  }
};

Meteor.startup(function() {
  var handle, onRequestFailed, onRequestSuccess, query;
  if (!Steedos.isMobile()) {
    if (Push.debug) {
      console.log("init notification observeChanges");
    }
    query = db.raix_push_notifications.find();
    onRequestSuccess = function() {
      return console.log("Request push permission success.");
    };
    onRequestFailed = function() {
      return console.log("Request push permission failed.");
    };
    Steedos.Push.Permission.request(onRequestSuccess, onRequestFailed);
    return handle = query.observeChanges({
      added: function(id, notification) {
        var options;
        console.log(notification);
        if (Steedos.isNewWindow()) {
          return;
        }
        options = {
          iconUrl: '',
          title: notification.title,
          body: notification.text,
          timeout: 15 * 1000,
          onClick: function(event) {
            console.log(event);
            if (event.target.tag) {
              if (event.target.tag.startsWith("/api/v4/notifications")) {
                Steedos.openWindow(event.target.tag);
              } else {
                FlowRouter.go(event.target.tag);
              }
            }
            window.focus();
            this.close();
          }
        };
        if (notification.payload) {
          if (notification.payload.requireInteraction) {
            options.requireInteraction = payload.requireInteraction;
          }
          if (notification.payload.notifications_id) {
            options.tag = "/api/v4/notifications/" + notification.payload.notifications_id + "/read";
          }
          if (notification.payload.app === "calendar") {
            options.tag = "/calendar/inbox";
          }
          if (notification.payload.instance) {
            options.tag = "/workflow/space/" + notification.payload.space + "/inbox/" + notification.payload.instance;
          }
        }
        if (options.title) {
          Steedos.Push.create(options.title, options);
        }
        Steedos.playNodeBadge(notification.badge);
      }
    });
  } else {
    if (Push.debug) {
      console.log("add addListener");
    }
    Push.onNotification = function(data) {
      var box, instance_url;
      box = 'inbox';
      if (data && data.payload) {
        if (data.payload.space && data.payload.instance) {
          instance_url = '/workflow/space/' + data.payload.space + '/' + box + '/' + data.payload.instance;
        }
      }
    };
    Push.addListener('startup', function(data) {
      if (Push.debug) {
        console.log('Push.Startup: Got message while app was closed/in background:', data);
      }
      return Push.onNotification(data);
    });
    return Push.addListener('message', function(data) {
      if (Push.debug) {
        console.log('Push.Message: Got message while app is open:', data);
      }
      Push.onNotification(data);
    });
  }
});