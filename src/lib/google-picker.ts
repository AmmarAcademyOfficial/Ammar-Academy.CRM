"use client";

/**
 * Opens Google's own file picker (real Google only). The token it receives is
 * limited to drive.file: picking a file is what grants the CRM access to it.
 * https://developers.google.com/workspace/drive/picker/guides/overview
 */

interface PickerConfig {
  accessToken: string;
  apiKey: string;
  appId: string;
}

type PickerData = { action: string; docs?: { id: string; name: string }[] };

// Google ships no types for the Picker; this is the small part the CRM uses.
interface PickerBuilder {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  addView(view: unknown): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  setCallback(cb: (data: PickerData) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface PickerNamespace {
  DocsView: new (viewId: unknown) => { setMode(mode: unknown): unknown };
  ViewId: { SPREADSHEETS: unknown };
  DocsViewMode: { LIST: unknown };
  Action: { PICKED: string; CANCEL: string };
  PickerBuilder: new () => PickerBuilder;
}
type PickerWindow = Window & { gapi?: { load(name: string, cb: () => void): void }; google?: { picker: PickerNamespace } };

let loading: Promise<void> | null = null;
function loadPickerApi(): Promise<void> {
  const w = window as PickerWindow;
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = () => w.gapi!.load("picker", () => resolve());
    s.onerror = () => {
      loading = null;
      reject(new Error("Could not load Google's file picker. Check your connection and try again."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Resolves with the picked spreadsheet, or null when the manager cancels. */
export async function pickSpreadsheet(cfg: PickerConfig): Promise<{ id: string; name: string } | null> {
  await loadPickerApi();
  const g = (window as PickerWindow).google!.picker;
  return new Promise((resolve) => {
    const view = new g.DocsView(g.ViewId.SPREADSHEETS);
    view.setMode(g.DocsViewMode.LIST);
    new g.PickerBuilder()
      .setAppId(cfg.appId) // the Cloud project number: required for drive.file access to the picked file
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      .addView(view)
      .setTitle("Choose the lead sheet")
      .setCallback((data) => {
        if (data.action === g.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name });
        else if (data.action === g.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
