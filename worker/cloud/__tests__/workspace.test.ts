import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { stabilizeIds, toSqliteValue, compactSnapshotPayload } from '../workspace';

test('current-season rebuild retains durable IDs and rewrites its child references', () => {
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE team_seasons(id INTEGER PRIMARY KEY,season INTEGER,espn_team_id INTEGER);
 CREATE TABLE matchups(id INTEGER PRIMARY KEY,season INTEGER,week INTEGER,espn_matchup_id INTEGER,home_team_season_id INTEGER,away_team_season_id INTEGER);
 CREATE TABLE roster_slots(id INTEGER PRIMARY KEY,season INTEGER,week INTEGER,team_season_id INTEGER,player_id INTEGER);
 CREATE TABLE transactions(id INTEGER PRIMARY KEY,season INTEGER,espn_tx_id TEXT);
 CREATE TABLE transaction_items(id INTEGER PRIMARY KEY,transaction_id INTEGER,team_season_id INTEGER,player_id INTEGER,action TEXT,source TEXT);
 CREATE TABLE draft_picks(id INTEGER PRIMARY KEY,season INTEGER,overall_pick INTEGER,team_season_id INTEGER);
 INSERT INTO team_seasons VALUES(80,2026,1),(81,2026,2);
 INSERT INTO matchups VALUES(600,2026,1,1,80,81);
 INSERT INTO roster_slots VALUES(30,2026,1,80,100);
 INSERT INTO transactions VALUES(50,2026,'new');
 INSERT INTO transaction_items VALUES(60,50,80,100,'add','espn');
 INSERT INTO draft_picks VALUES(90,2026,1,80);`);
 const original={team_seasons:[{id:60,season:2026,espn_team_id:1},{id:61,season:2026,espn_team_id:2}],matchups:[{id:500,season:2026,week:1,espn_matchup_id:1}],roster_slots:[{id:20,season:2026,week:1,team_season_id:60,player_id:100}],transactions:[],transaction_items:[],draft_picks:[{id:70,season:2026,overall_pick:1,team_season_id:60}]};
 stabilizeIds(db,2026,original);
 expect(db.prepare('SELECT * FROM matchups').get()).toEqual({id:500,season:2026,week:1,espn_matchup_id:1,home_team_season_id:60,away_team_season_id:61});
 expect(db.prepare('SELECT id,team_season_id FROM roster_slots').get()).toEqual({id:20,team_season_id:60});
 expect(db.prepare('SELECT id,team_season_id FROM draft_picks').get()).toEqual({id:70,team_season_id:60});
 db.close();
});

test('Postgres wire values round-trip through the existing computation types',()=>{
 expect(toSqliteValue('seasons','settings_json',{a:1})).toBe('{"a":1}');
 expect(toSqliteValue('franchises','active',true)).toBe(1);
 expect(toSqliteValue('stat_builds','started_at',new Date('2026-01-01T00:00:00Z'))).toBe(1767225600000);
});

test('compact boxscores retain the consumed player and projection fields without bulky unused stats',()=>{
 const player={id:7,fullName:'Fixture',defaultPositionId:1,eligibleSlots:[0],proTeamId:1,injuryStatus:'ACTIVE',stats:[{scoringPeriodId:4,statSourceId:1,appliedTotal:12.5,stats:{unused:99}}]};
 const payload={schedule:[{id:1,matchupPeriodId:4,playoffTierType:'NONE',home:{teamId:1,rosterForCurrentScoringPeriod:{entries:[{lineupSlotId:0,playerPoolEntry:{id:7,appliedStatTotal:15,player}}]}}}],teams:[{unused:'large'}]};
 const compact=JSON.parse(compactSnapshotPayload('mBoxscore,mMatchupScore,mRoster',JSON.stringify(payload)));
 expect(compact.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerPoolEntry.player.stats).toEqual([{scoringPeriodId:4,statSourceId:1,appliedTotal:12.5}]);
 expect(compact.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerPoolEntry.appliedStatTotal).toBe(15);
 expect(compact.schedule[0].playoffTierType).toBe('NONE');
 expect(compact.teams).toBeUndefined();
});
