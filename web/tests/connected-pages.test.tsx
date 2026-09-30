import {expect,test} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {PageContent} from '../src/pages/ConnectedPage';
import {decodePage} from '../src/api/pages';
const data=decodePage({season:2026,week:4,shell:{viewer:{managerId:1,role:'commissioner'},flags:{championFranchiseId:null,beltHolderFranchiseId:null,sackoFranchiseId:null,viewerFranchiseId:null}}});
test.each(['/','/matchups','/matchups/2026/4/1','/history','/franchises','/franchises/1','/h2h','/h2h/1/2','/seasons','/seasons/2026','/records','/belt','/timeline','/transactions','/what-if','/recaps','/recaps/2026/1','/admin','/admin/recaps','/admin/recaps/1','/admin/recaps/voice'])('route %s has a real empty state without placeholder or runtime failure',path=>{
 const html=renderToStaticMarkup(<MemoryRouter><PageContent data={data} path={path} search="" reload={()=>{}}/></MemoryRouter>);
 expect(html.length).toBeGreaterThan(30);
 expect(html).not.toMatch(/preview is being connected|undefined|NaN/);
});
