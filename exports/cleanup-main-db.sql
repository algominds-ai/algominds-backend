-- Keeps the five real accounts (Ondato, Mstone Group, Form3, Aris, Carta event pilot) and removes every other organisation with its data.
-- Run inside one transaction; take the backup first (see cleanup-main-db.sh).
begin;
create temp table gone as
  select id from organization where id not in (
    'BmKfV9yGno5dxzY5ZevgUIICoFUwJ8YY', -- aris
    'lNPW2kGMlRJ4hRYbuaEcSvqxKxXA54Ss', -- Mstone Group
    'vWn6GFmk046QIO1EEU4x5OYbshcIXaOM', -- Form3
    '7Uw6SetxKOVXo3KhkssVxVtNcnW764e5', -- Carta event pilot
    'A9tmpbLd1uuvD77t2tsVhw2Qvhe2Z95Y'  -- Ondato
  );
select 'organisations to delete' as what, count(*) from gone;
delete from evidence e
 where e.subject_id in (select id::text from person where organization_id in (select id from gone))
    or e.subject_id in (select rc.id::text from run_company rc join run r on r.id = rc.run_id where r.organization_id in (select id from gone))
    or e.subject_id in (select id::text from company where organization_id in (select id from gone))
    or e.subject_id in (select id::text from run where organization_id in (select id from gone));
delete from person      where organization_id in (select id from gone);
delete from run_company where run_id in (select id from run where organization_id in (select id from gone));
delete from company     where organization_id in (select id from gone);
delete from run         where organization_id in (select id from gone);
delete from apikey      where reference_id in (select id from gone);
delete from icp         where organization_id in (select id from gone);
delete from organization where id in (select id from gone);
select 'organisations left' as what, count(*) from organization;
select 'profiles left' as what, count(*) from icp;
select 'runs left' as what, count(*) from run;
commit;
