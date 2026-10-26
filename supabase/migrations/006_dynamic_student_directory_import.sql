-- Lift the original one-off 94-row import assumptions. Directory numbering may
-- be absent or may use any non-negative safe integer; record_index identifies
-- the extracted row within a source PDF independently of printed numbering.
alter table public.student_directory_imports
  alter column expected_records drop not null,
  alter column expected_records drop default,
  alter column expected_records type bigint,
  alter column detected_records type bigint;

alter table public.student_directory_records
  alter column directory_row drop not null,
  alter column directory_row type bigint,
  alter column record_index type bigint;

alter table public.student_directory_records
  drop constraint if exists student_directory_records_directory_row_check,
  drop constraint if exists student_directory_records_record_index_check;

alter table public.student_directory_records
  add constraint student_directory_records_directory_row_check
    check (directory_row is null or directory_row >= 0),
  add constraint student_directory_records_record_index_check
    check (record_index > 0);
