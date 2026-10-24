import zipCounties from "@/data/zip-counties.json";

export interface CountyChoice {
  fips: string;
  /** Census name, such as "Orange County", "Orleans Parish" or "St. Louis city". */
  name: string;
  state: string;
}

export interface ZipLocation {
  zipCode: string;
  state: string;
  counties: CountyChoice[];
}

const STATE_BY_FIPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
  "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
  "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
  "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

const data = zipCounties as { counties: Record<string, string>; zips: Record<string, string> };

export function stateForFips(fips: string) {
  return STATE_BY_FIPS[fips.slice(0, 2)] ?? "";
}

/** "Orange County" becomes "Orange", so a county can match Medicare.gov labels written either way. */
export function countyBaseName(name: string) {
  return name
    .replace(/\s+(?:County|Parish|Borough|City and Borough|Census Area|Municipality|Municipio|city)$/i, "")
    .trim();
}

function choice(fips: string, name: string): CountyChoice {
  return { fips, name, state: stateForFips(fips) };
}

/** County choices for any US ZIP code. The bundled Census table covers most ZIPs; PO-box ZIPs use a live lookup. */
export async function lookupZip(zipCode: string): Promise<ZipLocation | null> {
  if (!/^\d{5}$/.test(zipCode)) return null;
  const listed = data.zips[zipCode];
  if (listed) {
    const counties = listed.split(",").map((fips) => choice(fips, data.counties[fips] ?? fips));
    return { zipCode, state: counties[0].state, counties };
  }
  return lookupZipLive(zipCode);
}

async function lookupZipLive(zipCode: string): Promise<ZipLocation | null> {
  try {
    const zipResponse = await fetch(`https://api.zippopotam.us/us/${zipCode}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!zipResponse.ok) return null;
    const zipBody = (await zipResponse.json()) as {
      places?: { latitude: string; longitude: string; "state abbreviation": string }[];
    };
    const place = zipBody.places?.[0];
    if (!place) return null;
    const countyResponse = await fetch(
      `https://geo.fcc.gov/api/census/block/find?latitude=${place.latitude}&longitude=${place.longitude}&format=json`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!countyResponse.ok) return null;
    const countyBody = (await countyResponse.json()) as { County?: { FIPS?: string; name?: string } };
    const fips = countyBody.County?.FIPS;
    if (!fips) return null;
    const name = data.counties[fips] ?? countyBody.County?.name ?? fips;
    return { zipCode, state: place["state abbreviation"], counties: [choice(fips, name)] };
  } catch {
    return null;
  }
}
