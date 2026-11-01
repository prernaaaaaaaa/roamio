# Adding a destination

Create `server/data/<city>.json`. The file is validated at startup (`src/kb/loader.js`); a malformed file stops the server with a clear message.

```jsonc
{
  "city": "Agra",
  "state": "Uttar Pradesh",
  "aliases": ["taj mahal"],
  "tagline": "One line shown in the UI",
  "bestMonths": [10, 11, 12, 1, 2, 3],
  "avgSpeedKmph": 20,                       // typical road speed, used for travel-time estimates
  "signatureFood": "petha, bedai, chaat",   // used in meal suggestions
  "tiers": {                                // INR, approximate
    "budget":  { "hotelPerRoomNight": 1400, "foodPerPersonDay": 500,  "transportPerVehicleDay": 900 },
    "mid":     { "hotelPerRoomNight": 4000, "foodPerPersonDay": 1200, "transportPerVehicleDay": 1800 },
    "comfort": { "hotelPerRoomNight": 11000, "foodPerPersonDay": 2800, "transportPerVehicleDay": 3500 }
  },
  "seasons": [ { "months": [11,12,1,2], "label": "Cool season", "tempC": [8, 24], "rain": "low", "note": "..." } ],
  "places": [
    {
      "id": "agra-taj-mahal",               // globally unique, prefix with the city
      "name": "Taj Mahal",
      "category": "heritage",               // heritage|nature|food|adventure|shopping|spiritual|nightlife|relaxation|culture
      "area": "Taj Ganj",
      "lat": 27.1751, "lng": 78.0421,
      "hours": [6, 18.5],                   // opening and closing hour (24h, decimals allowed)
      "durationHrs": 3,
      "costINR": 1100,                      // per person
      "best": "morning",                    // morning|afternoon|evening|any
      "premium": false,                     // true for expensive extras (skipped in the Budget style)
      "availableMonths": [1,2,3],           // optional: omit if open all year
      "tags": ["mughal", "sunrise"],
      "desc": "One or two factual sentences."
    }
  ]
}
```

Guidelines: at least 10 places with a mix of categories; verify coordinates on a map (they drive travel times and the map); keep descriptions factual because they are shown to users. Restart the server and run `npm test`.
