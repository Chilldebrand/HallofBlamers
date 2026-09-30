import {expect,test} from 'vitest';
import {isAccessError} from '../src/api/access-error';
test('confirmed authorization failures clear data while transport failures retain mounted drafts',()=>{
 for(const e of [{code:'42501'},{code:'PGRST301'},{status:401},{status:403}])expect(isAccessError(e)).toBe(true);
 for(const e of [new TypeError('Failed to fetch'),{status:503},new Error('Offline')])expect(isAccessError(e)).toBe(false);
});
