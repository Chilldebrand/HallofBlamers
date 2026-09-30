import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import StandingsPage from "../src/pages/Standings";
import { buildStandings } from "../src/api/standings";

test("standings renders the original identity and repository-safe season links", () => {
  const model = buildStandings({ seasonOptions:[{season:2025,status:"complete"}], seasons:[{season:2025,status:"complete",teamCount:1}],
    franchises:[{id:1,canonicalName:"The Blamers",active:true}],teamSeasons:[{season:2025,franchiseId:1,wins:1,losses:0,ties:0,pointsFor:110,pointsAgainst:100,finalStanding:1}],
    seasonStats:[],careerStats:[],weeks:[{season:2025,week:1}],weekResults:[{franchiseId:1,season:2025,week:1,result:"W",margin:10}] }, {});
  const html = renderToStaticMarkup(<MemoryRouter><StandingsPage model={model} identityFlags={{championFranchiseId:1,viewerFranchiseId:1,sackoFranchiseId:null,beltHolderFranchiseId:null}} /></MemoryRouter>);
  expect(html).toContain("The Blamers");
  expect(html).toContain("text-kelly-deep");
  expect(html).toContain("/standings?season=career&amp;tab=real");
  expect(html).toContain("110.0");
});
