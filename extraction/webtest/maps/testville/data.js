// TEST FIXTURE ONLY — matches the CONTRACT.md data shape at realistic scale:
// full-sheet viewBox with tiny (6–20 pt) buildings clustered in the lower-left.
window.MAP_DATA = window.MAP_DATA || {};
window.MAP_DATA["testville"] = {
  name: "Testville",
  viewBox: [0, 0, 2415, 3146],
  baseSvg: "maps/testville/base.svg",
  buildings: [
    { n: 1,   cx: 204, cy: 2704, pts: [[200,2700],[208,2700],[208,2708],[200,2708]] },
    { n: 12,  cx: 254, cy: 2739, pts: [[250,2734],[258,2734],[258,2744],[250,2744]] },
    { n: 14,  cx: 307, cy: 2772, pts: [[300,2768],[314,2768],[314,2776],[300,2776]] },
    { n: 101, cx: 226, cy: 2846, pts: [[220,2840],[232,2840],[232,2852],[220,2852]] },
    { n: 102, cx: 283, cy: 2884, pts: [[276,2880],[290,2880],[290,2888],[276,2888]] },
    { n: 142, cx: 355, cy: 2925, pts: [[345,2920],[365,2920],[365,2930],[345,2930]] },
    { n: 143, cx: 408, cy: 2963, pts: [[405,2960],[411,2960],[411,2966],[405,2966]] },
    { n: 376, cx: 452, cy: 3006, pts: [[444,2998],[460,2998],[460,3014],[444,3014]] }
  ],
  landmarks: [
    { label: "NSHC Medical Clinic",       x: 330, y: 2800 },
    { label: "Alaska Commercial Company", x: 260, y: 2950 }
  ]
};
