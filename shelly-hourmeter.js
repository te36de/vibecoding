// Hour meter script for Shelly 1PM Mini Gen3 / Plug US Gen4 / any Gen2+ device
// Counts time above 27W (projector on, lasers off) and above 58W (lasers on)
//
// Usage meter URL:
//   http://192.168.124.213/script/1/usage
//
// Reset counters:
//   http://192.168.124.213/rpc/KVS.Set?key="high_power_minutes"&value="0"
//   http://192.168.124.213/rpc/KVS.Set?key="laser_minutes"&value="0"
//
// ---------------------------------------------------------------------------
// Virtual Text component setup - handled automatically by this script
// ---------------------------------------------------------------------------
// On every boot the script checks whether the virtual Text component with
// id VIRTUAL_TEXT_ID already exists (Text.GetConfig). If not, it creates it
// (Virtual.Add) before doing anything else. No manual setup step needed,
// not even on a brand new device - just upload the script and run it.
// Virtual components are per-device (limit: 10 per device), so this check
// runs again on a new/replacement Shelly and creates it there too.
//
// Manual equivalents, only needed for troubleshooting:
//   Check:  http://<device-ip>/rpc/Text.GetConfig?id=200
//   Create: http://<device-ip>/rpc/Virtual.Add?type="text"&id=200&config={"name":"Usage"}
//   Delete: http://<device-ip>/rpc/Virtual.Delete?key="text:200"
// ---------------------------------------------------------------------------

// Config
var PROJECTOR_THRESHOLD_W = 27;
var LASER_THRESHOLD_W = 58;
var KVS_KEY_PROJECTOR = "high_power_minutes";
var KVS_KEY_LASER = "laser_minutes";
var CHECK_INTERVAL_S = 10;
var SAVE_INTERVAL_MIN = 30; // do not kill nvram storage by too many writes
var VIRTUAL_TEXT_ID = 200;

var accumulated_seconds_proj = 0;
var accumulated_seconds_laser = 0;
var total_minutes_proj = 0;
var total_minutes_laser = 0;
var seconds_since_save = 0;
var current_power = 0;

function formatOnTime(mins) {
  var days = Math.floor(mins / 1440);
  var hours = Math.floor((mins % 1440) / 60);
  var minutes = mins % 60;
  return days + "d " + hours + "h " + minutes + "m";
}

function updateVirtual() {
  Shelly.call("Text.Set", { id: VIRTUAL_TEXT_ID, value: String(total_minutes_proj) + " min / " + String(total_minutes_laser) + " min laser" }, function(r, e) {
    if (e !== 0) print("Text.Set failed:", e);
  });
}

// Make sure the virtual Text component exists, creating it if needed,
// then invoke callback() to continue startup.
function ensureVirtualText(callback) {
  Shelly.call("Text.GetConfig", { id: VIRTUAL_TEXT_ID }, function(result, error) {
    if (error === 0 && result) {
      print("Virtual text component", VIRTUAL_TEXT_ID, "already exists");
      callback();
      return;
    }
    print("Virtual text component", VIRTUAL_TEXT_ID, "not found, creating it...");
    Shelly.call("Virtual.Add", { type: "text", id: VIRTUAL_TEXT_ID, config: { name: "Usage" } }, function(result2, error2) {
      if (error2 === 0) {
        print("Created virtual text component", VIRTUAL_TEXT_ID);
      } else {
        // Most likely cause: id already used by a different component type,
        // or the 10-virtual-components-per-device limit was reached.
        print("Failed to create virtual text component:", error2, "- usage page text display won't update, but counting/HTTP page still work");
      }
      callback();
    });
  });
}

function saveToKVS() {
  Shelly.call("KVS.Set", { key: KVS_KEY_PROJECTOR, value: String(total_minutes_proj) }, function(r, e) {
    if (e === 0) {
      print("Saved projector:", total_minutes_proj, "minutes");
    } else {
      print("KVS save failed (projector):", e);
    }
  });
  Shelly.call("KVS.Set", { key: KVS_KEY_LASER, value: String(total_minutes_laser) }, function(r, e) {
    if (e === 0) {
      print("Saved laser:", total_minutes_laser, "minutes");
    } else {
      print("KVS save failed (laser):", e);
    }
  });
}

// Startup: make sure the virtual component exists, then load stored values from KVS
ensureVirtualText(function() {
  Shelly.call("KVS.Get", { key: KVS_KEY_PROJECTOR }, function(result, error) {
    if (error === 0 && result && result.value !== undefined) {
      total_minutes_proj = Number(result.value);
      print("Loaded projector minutes:", total_minutes_proj);
    } else {
      total_minutes_proj = 0;
      print("No projector value found, starting from 0");
    }
    Shelly.call("KVS.Get", { key: KVS_KEY_LASER }, function(result2, error2) {
      if (error2 === 0 && result2 && result2.value !== undefined) {
        total_minutes_laser = Number(result2.value);
        print("Loaded laser minutes:", total_minutes_laser);
      } else {
        total_minutes_laser = 0;
        print("No laser value found, starting from 0");
      }
      updateVirtual();
    });
  });
});

// HTTP endpoint
HTTPServer.registerEndpoint("usage", function(request, response) {
  var html = "<html><head>" +
    "<meta http-equiv='refresh' content='2'>" +
    "<style>body{font-family:monospace;font-size:1.4em;padding:20px;background:#111;color:#eee;}" +
    ".power{color:#7cf;} .projector{color:#7fc;} .laser{color:#fc7;} .label{color:#888;}</style>" +
    "</head><body>" +
    "<div class='label'>Current power</div>" +
    "<div class='power'>" + current_power.toFixed(1) + " W</div>" +
    "<br>" +
    "<div class='label'>Projector on-time (above " + PROJECTOR_THRESHOLD_W + "W)</div>" +
    "<div class='projector'>" + formatOnTime(total_minutes_proj) + "</div>" +
    "<br>" +
    "<div class='label'>Laser on-time (above " + LASER_THRESHOLD_W + "W)</div>" +
    "<div class='laser'>" + formatOnTime(total_minutes_laser) + "</div>" +
    "</body></html>";
  response.code = 200;
  response.headers = [["Content-Type", "text/html"]];
  response.body = html;
  response.send();
});

// Poll power every CHECK_INTERVAL_S seconds
Timer.set(CHECK_INTERVAL_S * 1000, true, function() {
  Shelly.call("Switch.GetStatus", { id: 0 }, function(result, error) {
    if (error !== 0 || !result) return;
    var power = result.apower;
    if (power === undefined) {
      print("No power reading available");
      return;
    }
    current_power = power;

    if (power > PROJECTOR_THRESHOLD_W) {
      accumulated_seconds_proj += CHECK_INTERVAL_S;
      if (accumulated_seconds_proj >= 60) {
        total_minutes_proj += Math.floor(accumulated_seconds_proj / 60);
        accumulated_seconds_proj = accumulated_seconds_proj % 60;
      }
    }

    if (power > LASER_THRESHOLD_W) {
      accumulated_seconds_laser += CHECK_INTERVAL_S;
      if (accumulated_seconds_laser >= 60) {
        total_minutes_laser += Math.floor(accumulated_seconds_laser / 60);
        accumulated_seconds_laser = accumulated_seconds_laser % 60;
      }
    }

    updateVirtual();

    seconds_since_save += CHECK_INTERVAL_S;
    if (seconds_since_save >= SAVE_INTERVAL_MIN * 60) {
      saveToKVS();
      seconds_since_save = 0;
    }

    print("Power:", power, "W | Projector:", formatOnTime(total_minutes_proj), "| Laser:", formatOnTime(total_minutes_laser));
  });
});
