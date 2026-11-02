// Koppelingstest: stuurt een testscan naar MailBlue (ActiveCampaign API v3).
// De sleutel staat als omgevingsvariabele in Netlify en komt nooit in de browser.

const VELD = {
  bedrijfsnaam: "27",
  verhaal: "22",
  doelgroep: "23",
  identiteit: "24",
  landing: "25",
  totaal: "26",
};
const TAG_SCAN = "59";

const TESTSCORES = { verhaal: 3, doelgroep: 2, identiteit: 3, landing: 2 };

function antwoord(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function basisUrl(ruw) {
  // Vergeeft een schuine streep of /api/3 aan het eind.
  return schoon(ruw).replace(/\/+$/, "").replace(/\/api\/3$/, "");
}

function schoon(waarde) {
  // Haalt spaties, regeleindes en aanhalingstekens rond een waarde weg.
  return String(waarde).trim().replace(/^["']+|["']+$/g, "").trim();
}

// Controleert of MailBlue de sleutel accepteert, en geeft bij een fout
// alleen kenmerken terug (nooit de sleutel zelf).
async function controleerSleutel(ruweUrl, ruweSleutel) {
  const sleutel = schoon(ruweSleutel);
  const basis = basisUrl(ruweUrl);
  const kenmerken = {
    host: (() => { try { return new URL(basis).host; } catch { return "ongeldig adres"; } })(),
    adresBegintMetHttps: basis.startsWith("https://"),
    sleutelLengte: sleutel.length,
    sleutelHadSpatiesOfQuotes: sleutel !== String(ruweSleutel),
  };
  let res;
  try {
    res = await fetch(`${basis}/api/3/users/me`, {
      headers: { "Api-Token": sleutel, Accept: "application/json" },
      redirect: "manual",
    });
  } catch (e) {
    return { ok: false, status: 0, kenmerken, fout: `Adres niet bereikbaar: ${e.message}` };
  }
  if (res.status >= 300 && res.status < 400) {
    const naar = res.headers.get("location") || "onbekend";
    let naarHost = naar;
    try { naarHost = new URL(naar, basis).host; } catch {}
    return { ok: false, status: res.status, kenmerken, fout: `Het adres stuurt door naar ${naarHost}. Gebruik dat adres als MAILBLUE_API_URL.` };
  }
  if (!res.ok) {
    const tekst = (await res.text()).slice(0, 300);
    return { ok: false, status: res.status, kenmerken, fout: tekst };
  }
  return { ok: true, sleutel, basis };
}

export default async (req) => {
  if (req.method !== "POST") {
    return antwoord(405, { success: false, stap: "methode", status: 405, fout: "Alleen POST is toegestaan." });
  }

  const ruweUrl = process.env.MAILBLUE_API_URL;
  const sleutel = process.env.MAILBLUE_API_KEY;
  const ontbreekt = [];
  if (!ruweUrl) ontbreekt.push("MAILBLUE_API_URL");
  if (!sleutel) ontbreekt.push("MAILBLUE_API_KEY");
  if (ontbreekt.length) {
    return antwoord(500, {
      success: false,
      stap: "config",
      status: 0,
      fout: `Ontbreekt in Netlify: ${ontbreekt.join(" en ")}. Zet de variabele erin en deploy opnieuw.`,
    });
  }

  let invoer;
  try {
    invoer = await req.json();
  } catch {
    return antwoord(400, { success: false, stap: "invoer", status: 400, fout: "Geen geldige gegevens ontvangen." });
  }

  const voornaam = String(invoer.voornaam || "").trim();
  const email = String(invoer.email || "").trim();
  const bedrijfsnaam = String(invoer.bedrijfsnaam || "").trim();
  if (!voornaam || !email || !bedrijfsnaam) {
    return antwoord(400, { success: false, stap: "invoer", status: 400, fout: "Voornaam, e-mailadres en bedrijfsnaam zijn verplicht." });
  }

  // Stap 0: eerst controleren of MailBlue de sleutel accepteert.
  const check = await controleerSleutel(ruweUrl, sleutel);
  if (!check.ok) {
    const k = check.kenmerken;
    const uitleg =
      `${check.fout}\n\nAdres: ${k.host} (https: ${k.adresBegintMetHttps ? "ja" : "nee"})` +
      `\nSleutel: ${k.sleutelLengte} tekens, spaties of quotes eromheen: ${k.sleutelHadSpatiesOfQuotes ? "ja" : "nee"}`;
    return antwoord(502, { success: false, stap: "sleutelcheck", status: check.status, fout: uitleg });
  }

  const totaal = Object.values(TESTSCORES).reduce((a, b) => a + b, 0);
  const basis = check.basis;
  const headers = { "Api-Token": check.sleutel, "Content-Type": "application/json", Accept: "application/json" };

  // Stap 1: contact aanmaken of bijwerken, met velden.
  const syncRes = await fetch(`${basis}/api/3/contact/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contact: {
        email,
        firstName: voornaam,
        fieldValues: [
          { field: VELD.bedrijfsnaam, value: bedrijfsnaam },
          { field: VELD.verhaal, value: String(TESTSCORES.verhaal) },
          { field: VELD.doelgroep, value: String(TESTSCORES.doelgroep) },
          { field: VELD.identiteit, value: String(TESTSCORES.identiteit) },
          { field: VELD.landing, value: String(TESTSCORES.landing) },
          { field: VELD.totaal, value: String(totaal) },
        ],
      },
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));

  const syncTekst = await syncRes.text();
  if (!syncRes.ok) {
    return antwoord(502, { success: false, stap: "contact", status: syncRes.status, fout: syncTekst.slice(0, 500) });
  }

  let contactId;
  try {
    contactId = JSON.parse(syncTekst).contact.id;
  } catch {
    return antwoord(502, { success: false, stap: "contact", status: syncRes.status, fout: "Geen contact ID in het antwoord van MailBlue." });
  }

  // Stap 2: tag "Video Marketing Scan" toevoegen.
  const tagRes = await fetch(`${basis}/api/3/contactTags`, {
    method: "POST",
    headers,
    body: JSON.stringify({ contactTag: { contact: contactId, tag: TAG_SCAN } }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));

  const tagTekst = await tagRes.text();
  const tagBestaatAl = tagRes.status === 422 && /already|bestaat|exists/i.test(tagTekst);
  if (!tagRes.ok && !tagBestaatAl) {
    return antwoord(502, { success: false, stap: "tag", status: tagRes.status, contactId, fout: tagTekst.slice(0, 500) });
  }

  return antwoord(200, { success: true, contactId, tagBestondAl: tagBestaatAl });
};
