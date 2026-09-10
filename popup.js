const steamSearchInput = document.querySelector("#steam-search");
const lookupButton = document.querySelector("#lookup-button");
const lookupStatus = document.querySelector("#lookup-status");
const searchResults = document.querySelector("#search-results");
const cartStatus = document.querySelector("#cart-status");
const openSteamStoreButton = document.querySelector("#open-steam-store");

const STEAM_STORE_URL = "https://store.steampowered.com/";

const setLookupStatus = (message, state = "") => {
  lookupStatus.textContent = message;
  lookupStatus.dataset.state = state;
};

const setCartStatus = (message, state = "") => {
  cartStatus.textContent = message;
  cartStatus.dataset.state = state;
};

const isSteamStoreUrl = (url) => {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && parsedUrl.hostname === "store.steampowered.com";
  } catch {
    return false;
  }
};

const getSteamStoreTab = async ({ announceReady = false } = {}) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("We couldn't find an open tab.");
  }

  if (!isSteamStoreUrl(tab.url)) {
    setCartStatus("To add a game, open the Steam Store first.", "error");
    openSteamStoreButton.hidden = false;
    return null;
  }

  openSteamStoreButton.hidden = true;
  if (announceReady) {
    setCartStatus("Steam Store is ready.", "success");
  }
  return tab;
};

const getJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error("Steam is unavailable right now. Please try again.");
  }

  return response.json();
};

const getSteamApp = async (appId) => {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.search = new URLSearchParams({ appids: String(appId), cc: "au", l: "english" });
  const data = await getJson(url);
  const result = data[String(appId)];

  if (!result?.success || !result.data) {
    throw new Error("Steam couldn't find that game.");
  }

  return result.data;
};

const searchSteamApps = async (term) => {
  const url = new URL("https://store.steampowered.com/api/storesearch/");
  url.search = new URLSearchParams({ term, cc: "au", l: "english", max_results: "6" });
  const data = await getJson(url);

  return Array.isArray(data.items) ? data.items.slice(0, 6) : [];
};

const getCapsuleImageUrl = (appId) => (
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_231x87.jpg`
);

const getMainStorePackageId = (app) => {
  const packageGroup = app.package_groups?.find(({ name }) => name === "default")
    || app.package_groups?.[0];
  const packageId = packageGroup?.subs?.[0]?.packageid || app.packages?.[0];

  if (!Number.isInteger(packageId) || packageId <= 0) {
    throw new Error("This game doesn't have a main store package on Steam.");
  }

  return packageId;
};

const toCartApp = (app) => ({
  id: app.steam_appid,
  name: app.name || "Untitled Steam app",
  packageId: getMainStorePackageId(app)
});

const findAppsWithMainStorePackages = async (apps) => {
  const results = await Promise.all(apps.map(async (app) => {
    try {
      return toCartApp(await getSteamApp(app.id));
    } catch {
      return null;
    }
  }));

  return results.filter(Boolean);
};

const callAddToCart = async (packageId) => {
  if (typeof globalThis.addToCart !== "function") {
    throw new Error("This page doesn't have a cart function we can use.");
  }

  await globalThis.addToCart(packageId);
  return null;
};

const sendPackageToSteamStore = async (packageId, tabId) => {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: callAddToCart,
    args: [packageId]
  });
};

const addAppToCart = async (app, button) => {
  if (button.disabled) {
    return;
  }

  button.disabled = true;

  try {
    // Check the current tab on every click, before looking up a package.
    const steamStoreTab = await getSteamStoreTab({ announceReady: true });
    if (!steamStoreTab) {
      return;
    }

    setCartStatus(`Adding ${app.name}…`);

    // Check again after the network request so a tab change cannot send the
    // cart action to a non-Steam page.
    const currentSteamStoreTab = await getSteamStoreTab();
    if (!currentSteamStoreTab) {
      return;
    }

    await sendPackageToSteamStore(app.packageId, currentSteamStoreTab.id);
    setCartStatus(`${app.name} was sent to your cart.`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCartStatus(message, "error");
  } finally {
    button.disabled = false;
  }
};

const showSearchResults = (apps) => {
  searchResults.replaceChildren();
  setCartStatus("");

  for (const app of apps) {
    const result = document.createElement("div");
    const capsuleImage = document.createElement("img");
    const content = document.createElement("div");
    const appName = document.createElement("span");
    const addButton = document.createElement("button");

    result.className = "steam-result";
    capsuleImage.className = "steam-capsule";
    capsuleImage.src = getCapsuleImageUrl(app.id);
    capsuleImage.alt = "";
    capsuleImage.addEventListener("error", () => {
      capsuleImage.remove();
      result.classList.add("steam-result--no-image");
    }, { once: true });
    content.className = "steam-result-content";
    appName.className = "steam-result-name";
    appName.textContent = app.name || "Untitled Steam app";
    addButton.type = "button";
    addButton.textContent = "Add to cart";
    addButton.addEventListener("click", () => addAppToCart(app, addButton));
    content.append(appName, addButton);
    result.append(capsuleImage, content);
    searchResults.append(result);
  }
};

const lookupSteamApp = async () => {
  if (lookupButton.disabled) {
    return;
  }

  const query = steamSearchInput.value.trim();
  if (!query) {
    setLookupStatus("Type a game title to get started.", "error");
    return;
  }

  lookupButton.disabled = true;
  searchResults.replaceChildren();
  setCartStatus("");
  setLookupStatus("Looking on Steam…");

  try {
    if (/^\d+$/.test(query)) {
      const app = await getSteamApp(query);
      showSearchResults([toCartApp(app)]);
      setLookupStatus("Found 1 match.", "success");
      return;
    }

    const apps = await searchSteamApps(query);
    if (!apps.length) {
      setLookupStatus("Nothing matched that search. Try another title.", "error");
      return;
    }

    setLookupStatus("Checking which games can be added…");
    const addableApps = await findAppsWithMainStorePackages(apps);
    if (!addableApps.length) {
      setLookupStatus("No games with a main Steam store package matched that search.", "error");
      return;
    }

    showSearchResults(addableApps);
    setLookupStatus(`Found ${addableApps.length} game${addableApps.length === 1 ? "" : "s"}. Pick one to add it.`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLookupStatus(message, "error");
  } finally {
    lookupButton.disabled = false;
  }
};

lookupButton.addEventListener("click", lookupSteamApp);
steamSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    lookupSteamApp();
  }
});

openSteamStoreButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: STEAM_STORE_URL });
  } else {
    await chrome.tabs.create({ url: STEAM_STORE_URL });
  }
});

getSteamStoreTab().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setCartStatus(message, "error");
});
