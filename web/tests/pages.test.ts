import {expect,test} from 'vitest';
import {pageRequest,decodePage,matchupScore} from '../src/api/pages';
test('nested match detail preserves all route parameters and rejects malformed IDs',()=>{
 expect(pageRequest('/matchups/2026/4/99','')).toMatchObject({page_route:'matchups',requested_season:2026,requested_week:4,requested_id:99});
 expect(pageRequest('/matchups/2026/no/99','')).toBeNull();
 expect(pageRequest('/polls/1','')).toBeNull();
 expect(pageRequest('/not-a-page','')).toBeNull();
});
test('decode translates only row keys, keeping event payload fields intact',()=>{
 const data=decodePage({shell:{},season:2026,week:4,events:[{id:1,payload_json:{team_name:'Keep this key'}}]});
 expect(data.events[0].payloadJson).toEqual({team_name:'Keep this key'});
 expect(data.recaps).toEqual([]);
});
test('scheduled zero scores are not displayed as completed results',()=>{
 expect(matchupScore(false,0,104.5)).toBe('104.5 projected');
 expect(matchupScore(true,0,104.5)).toBe('0.0');
 expect(matchupScore(false,45.12,104.5)).toBe('45.1 · in progress');
});

