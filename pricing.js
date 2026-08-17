// ============================================================
//  myLucent.co — PRICING CONFIGURATION
// ============================================================
//  Edit the numbers below to update prices across the WHOLE
//  site. Nothing else needs to change — the price table shown
//  to customers, AND the actual amount charged at checkout,
//  both read directly from this one file.
//
//  HOW TO EDIT:
//  For each size, fill in the total price (in AUD dollars, no
//  $ sign) for ordering 1, 2, or 3 identical plaques. If a
//  customer orders MORE than 3, each extra one is charged at
//  "additionalUnitPrice".
//
//  Example: if Small should be $35 for 1, $65 for 2, $90 for 3,
//  and $28 for each one after that, write:
//
//    pricing: { 1: 35, 2: 65, 3: 90 },
//    additionalUnitPrice: 28
//
//  After editing this file, upload/push it to your GitHub repo
//  the same way you do with server.js — Railway will redeploy
//  automatically and the new prices go live.
// ============================================================

module.exports = {
  currency: "aud",

  small: {
    label: "Small (45 × 10.4mm)",
    pricing: {
      1: 20, // <-- set price for ordering 1
      2: 25, // <-- set TOTAL price for ordering 2
      3: 32, // <-- set TOTAL price for ordering 3
    },
    additionalUnitPrice: 2.5, // price for each extra beyond 3
  },

  medium: {
    label: "Medium (65 × 15mm)",
    pricing: {
      1: 25, // <-- set price for ordering 1
      2: 35, // <-- set TOTAL price for ordering 2
      3: 40, // <-- set TOTAL price for ordering 3
    },
    additionalUnitPrice: 2.5, // price for each extra beyond 3
  },

  large: {
    label: "Large (85 × 19.6mm)",
    pricing: {
      1: 25, // <-- set price for ordering 1
      2: 35, // <-- set TOTAL price for ordering 2
      3: 40, // <-- set TOTAL price for ordering 3
    },
    additionalUnitPrice: 2.5, // price for each extra beyond 3
  },

  // Custom sizes are handled separately (quote by phone/email) and
  // are not priced through this file.
};
