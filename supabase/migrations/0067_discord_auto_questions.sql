-- Durable, service-role-only Discord auto-question state. No student AI billing.
-- RPCs serialize all writes on the singleton config row. Unknown model costs keep
-- their full reservation forever; ambiguous generation/delivery is never retried.
begin;

create table public.discord_auto_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  excluded_channel_ids text[] not null default '{}',
  activation_at timestamptz,
  daily_budget_microusd bigint not null default 250000 check (daily_budget_microusd between 0 and 1000000),
  lifetime_budget_microusd bigint not null default 5000000 check (lifetime_budget_microusd between 0 and 5000000),
  max_replies_per_day integer not null default 100 check (max_replies_per_day between 0 and 100),
  user_cooldown_seconds integer not null default 60 check (user_cooldown_seconds between 60 and 86400),
  channel_cooldown_seconds integer not null default 60 check (channel_cooldown_seconds between 60 and 86400),
  lease_id uuid,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  last_run_started_at timestamptz,
  last_run_finished_at timestamptz,
  last_run_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(last_run_summary) = 'object' and octet_length(last_run_summary::text) <= 2000),
  last_error text check (last_error ~ '^[a-z0-9_]{1,64}$'),
  backoff_until timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or activation_at is not null),
  check (cardinality(excluded_channel_ids) <= 100)
);
insert into public.discord_auto_config (id) values (true);

create table public.discord_auto_jobs (
  message_id text primary key check (message_id ~ '^[0-9]{1,20}$'),
  channel_id text not null check (channel_id ~ '^[0-9]{1,20}$'),
  user_id text not null check (user_id ~ '^[0-9]{1,20}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_created_at timestamptz not null,
  -- Budget day comes from database time, not the Discord timestamp or RPC input.
  budget_day date not null,
  status text not null check (status in ('generating','generated','sending','sent','skipped','uncertain')),
  reason text check (reason ~ '^[a-z0-9_]{1,64}$'),
  generation_fence bigint not null,
  reservation_microusd bigint not null default 0 check (reservation_microusd in (0,16000)),
  input_tokens integer check (input_tokens between 0 and 12000),
  output_tokens integer check (output_tokens between 0 and 700),
  actual_microusd bigint check (actual_microusd between 0 and 15500),
  settled_at timestamptz,
  -- Only the answer is temporarily persisted; never the original question/context.
  answer text check (char_length(answer) between 1 and 1900),
  answer_expires_at timestamptz,
  send_started_at timestamptz,
  send_fence bigint,
  reply_message_id text unique check (reply_message_id ~ '^[0-9]{1,20}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((actual_microusd is null and settled_at is null and input_tokens is null and output_tokens is null)
    or (actual_microusd = input_tokens + 5::bigint * output_tokens and settled_at is not null and input_tokens is not null and output_tokens is not null)),
  check ((answer is null) = (answer_expires_at is null)),
  check (status <> 'sent' or (reply_message_id is not null and answer is null))
);
create index discord_auto_jobs_budget_idx on public.discord_auto_jobs (budget_day) where reservation_microusd > 0;
create index discord_auto_jobs_user_idx on public.discord_auto_jobs (user_id, created_at desc) where reservation_microusd > 0;
create index discord_auto_jobs_channel_idx on public.discord_auto_jobs (channel_id, created_at desc) where reservation_microusd > 0;
create index discord_auto_jobs_pending_idx on public.discord_auto_jobs (status, created_at) where status in ('generated','sending','uncertain');

create table public.discord_auto_cursors (
  channel_id text primary key check (channel_id ~ '^[0-9]{1,20}$'),
  last_message_id text not null check (last_message_id ~ '^[0-9]{1,20}$'),
  last_polled_at timestamptz not null,
  lease_fence bigint not null,
  updated_at timestamptz not null default now()
);

alter table public.discord_auto_config enable row level security;
alter table public.discord_auto_jobs enable row level security;
alter table public.discord_auto_cursors enable row level security;
-- No browser policies. Even service_role mutations must use the serialized RPC.
revoke all on public.discord_auto_config, public.discord_auto_jobs, public.discord_auto_cursors from public, anon, authenticated, service_role;
grant select on public.discord_auto_config, public.discord_auto_jobs, public.discord_auto_cursors to service_role;

create function public.discord_auto_state() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.discord_auto_config%rowtype;
  master_enabled boolean;
  today date := timezone('UTC', clock_timestamp())::date;
  daily_spent bigint; daily_reserved bigint; daily_calls bigint;
  lifetime_spent bigint; lifetime_reserved bigint;
begin
  select * into strict c from public.discord_auto_config where id = true;
  select coalesce(value in ('true'::jsonb, '"true"'::jsonb), false) into master_enabled
    from public.site_settings where key = 'discord_enabled';
  master_enabled := coalesce(master_enabled, false);
  select coalesce(sum(actual_microusd),0),
    coalesce(sum(case when actual_microusd is null then reservation_microusd else 0 end),0),
    count(*) filter (where reservation_microusd > 0)
    into daily_spent,daily_reserved,daily_calls from public.discord_auto_jobs where budget_day = today;
  select coalesce(sum(actual_microusd),0),
    coalesce(sum(case when actual_microusd is null then reservation_microusd else 0 end),0)
    into lifetime_spent,lifetime_reserved from public.discord_auto_jobs;
  return jsonb_build_object(
    'enabled', c.enabled, 'masterEnabled', master_enabled, 'effectiveEnabled', c.enabled and master_enabled,
    'excludedChannelIds', to_jsonb(c.excluded_channel_ids), 'activationAt', c.activation_at,
    'activationSnowflake', case when c.activation_at is not null then
      (floor(extract(epoch from c.activation_at) * 1000 - 1420070400000) * 4194304)::numeric(20,0)::text else null end,
    'dailyBudgetMicrousd', c.daily_budget_microusd, 'lifetimeBudgetMicrousd', c.lifetime_budget_microusd,
    'maxRepliesPerDay', c.max_replies_per_day, 'userCooldownSeconds', c.user_cooldown_seconds,
    'channelCooldownSeconds', c.channel_cooldown_seconds, 'budgetDay', today,
    'dailySpentMicrousd', daily_spent, 'dailyReservedMicrousd', daily_reserved, 'dailyCalls', daily_calls,
    'lifetimeSpentMicrousd', lifetime_spent, 'lifetimeReservedMicrousd', lifetime_reserved,
    'lastRunStartedAt', c.last_run_started_at, 'lastRunFinishedAt', c.last_run_finished_at,
    'lastError', c.last_error, 'lastRunSummary', c.last_run_summary,
    'backoffUntil', c.backoff_until, 'leaseExpiresAt', c.lease_expires_at);
end $$;

-- One entry point keeps authorization and lock ordering identical for every
-- transition. RPC inputs cannot set budget day, cost, lease TTL, or activation.
create function public.discord_auto_transition(p_action text, p_input jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.discord_auto_config%rowtype;
  j public.discord_auto_jobs%rowtype;
  v_now timestamptz;
  v_day date;
  v_lease uuid;
  v_fence bigint;
  v_message text;
  v_channel text;
  v_user text;
  v_reason text;
  v_source_at timestamptz;
  v_activation_snowflake text;
  v_master boolean;
  v_daily bigint;
  v_total bigint;
  v_calls bigint;
  v_input integer;
  v_output integer;
  v_actual bigint;
  v_answer text;
  v_reply text;
  v_enabled boolean;
  v_source_hash text;
  v_summary jsonb;
  v_retry_after integer;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into strict c from public.discord_auto_config where id = true for update;
  v_now := clock_timestamp();
  v_day := timezone('UTC', v_now)::date;
  select coalesce(value in ('true'::jsonb, '"true"'::jsonb), false) into v_master
    from public.site_settings where key = 'discord_enabled';
  v_master := coalesce(v_master, false);
  if c.activation_at is not null then
    v_activation_snowflake := (floor(extract(epoch from c.activation_at) * 1000 - 1420070400000) * 4194304)::numeric(20,0)::text;
  end if;

  if p_action = 'configure' then
    if exists (select 1 from jsonb_object_keys(p_input) k where k not in
      ('enabled','excludedChannelIds','dailyBudgetMicrousd','lifetimeBudgetMicrousd','maxRepliesPerDay','userCooldownSeconds','channelCooldownSeconds')) then
      raise exception 'unknown_config_key' using errcode = '22023';
    end if;
    if (p_input ? 'enabled' and jsonb_typeof(p_input->'enabled') <> 'boolean')
      or (p_input ? 'excludedChannelIds' and jsonb_typeof(p_input->'excludedChannelIds') <> 'array') then
      raise exception 'invalid_config' using errcode = '22023';
    end if;
    if p_input ? 'excludedChannelIds' then
      if exists (select 1 from jsonb_array_elements(p_input->'excludedChannelIds') x
        where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[0-9]{1,20}$') then
        raise exception 'invalid_channel_id' using errcode = '22023';
      end if;
    end if;
    v_enabled := coalesce((p_input->>'enabled')::boolean, c.enabled);
    update public.discord_auto_config set
      enabled = v_enabled,
      activation_at = case when v_enabled and not c.enabled then v_now else c.activation_at end,
      excluded_channel_ids = case when p_input ? 'excludedChannelIds' then
        array(select distinct jsonb_array_elements_text(p_input->'excludedChannelIds')) else c.excluded_channel_ids end,
      daily_budget_microusd = coalesce((p_input->>'dailyBudgetMicrousd')::bigint, c.daily_budget_microusd),
      lifetime_budget_microusd = coalesce((p_input->>'lifetimeBudgetMicrousd')::bigint, c.lifetime_budget_microusd),
      max_replies_per_day = coalesce((p_input->>'maxRepliesPerDay')::integer, c.max_replies_per_day),
      user_cooldown_seconds = coalesce((p_input->>'userCooldownSeconds')::integer, c.user_cooldown_seconds),
      channel_cooldown_seconds = coalesce((p_input->>'channelCooldownSeconds')::integer, c.channel_cooldown_seconds),
      updated_at = v_now where id = true;
    return public.discord_auto_state();
  end if;

  if p_action = 'acquire_run' then
    if c.backoff_until is not null and c.backoff_until > v_now then return null; end if;
    if c.lease_id is not null and c.lease_expires_at > v_now then return null; end if;
    -- A previous worker may have paid for generation. Never regenerate or refund
    -- an abandoned call, and never turn an ambiguous send back into generated.
    update public.discord_auto_jobs set status = 'uncertain', reason = 'generation_abandoned',
      answer = null, answer_expires_at = null, updated_at = v_now where status = 'generating';
    update public.discord_auto_jobs set status = case when status = 'generated' then 'uncertain' else status end,
      reason = case when status = 'generated' then 'answer_expired' else reason end,
      answer = null, answer_expires_at = null, updated_at = v_now
      where answer_expires_at <= v_now;
    v_lease := gen_random_uuid();
    update public.discord_auto_config set lease_id = v_lease, lease_fence = lease_fence + 1,
      lease_expires_at = v_now + interval '240 seconds', last_run_started_at = v_now,
      last_error = null, updated_at = v_now where id = true returning lease_fence into v_fence;
    return jsonb_build_object('leaseId',v_lease,'fence',v_fence,'expiresAt',v_now + interval '240 seconds');
  end if;

  v_lease := (p_input->>'leaseId')::uuid;
  v_fence := (p_input->>'fence')::bigint;
  if v_lease is null or v_fence is null or c.lease_id is distinct from v_lease
    or c.lease_fence <> v_fence or c.lease_expires_at is null or c.lease_expires_at <= v_now then
    raise exception 'stale_lease' using errcode = '55000';
  end if;

  if p_action = 'release_run' then
    v_reason := p_input->>'error';
    if v_reason is not null and v_reason !~ '^[a-z0-9_]{1,64}$' then raise exception 'invalid_reason' using errcode = '22023'; end if;
    v_summary := coalesce(p_input->'summary','{}'::jsonb);
    if jsonb_typeof(v_summary) <> 'object' or octet_length(v_summary::text) > 2000 then raise exception 'invalid_summary' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_each(v_summary) e where e.key !~ '^[a-zA-Z][a-zA-Z0-9_]{0,39}$'
      or jsonb_typeof(e.value) not in ('number','string','boolean')
      or (jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') !~ '^[a-zA-Z0-9_]{1,64}$')
      or (jsonb_typeof(e.value) = 'number' and (e.value #>> '{}') !~ '^[0-9]{1,9}$')) then
      raise exception 'invalid_summary' using errcode = '22023';
    end if;
    v_retry_after := coalesce((p_input->>'retryAfterMs')::integer,0);
    if v_retry_after < 0 or v_retry_after > 86400000 then raise exception 'invalid_backoff' using errcode = '22023'; end if;
    update public.discord_auto_config set lease_id = null, lease_expires_at = null,
      last_run_finished_at = v_now, last_error = v_reason, last_run_summary = v_summary,
      backoff_until = case when v_retry_after > 0 then greatest(backoff_until, v_now + make_interval(secs => v_retry_after / 1000.0)) else backoff_until end,
      updated_at = v_now where id = true;
    return jsonb_build_object('released',true);
  elsif p_action = 'get_cursors' then
    return coalesce((select jsonb_agg(jsonb_build_object('channelId',channel_id,
      'lastMessageId', greatest(last_message_id::numeric, coalesce(v_activation_snowflake,'0')::numeric)::text,
      'lastPolledAt',last_polled_at) order by last_polled_at,channel_id) from public.discord_auto_cursors), '[]'::jsonb);
  elsif p_action = 'advance_cursor' then
    v_channel := p_input->>'channelId';
    v_message := coalesce(p_input->>'messageId',v_activation_snowflake);
    if v_channel is null or v_channel !~ '^[0-9]{1,20}$' or v_message is null or v_message !~ '^[0-9]{1,20}$'
      or v_message::numeric > (floor(extract(epoch from v_now) * 1000 - 1420070400000) + 60000) * 4194304 then
      raise exception 'invalid_cursor' using errcode = '22023';
    end if;
    insert into public.discord_auto_cursors(channel_id,last_message_id,last_polled_at,lease_fence,updated_at)
      values(v_channel,v_message,v_now,v_fence,v_now)
      on conflict(channel_id) do update set
        last_message_id = greatest(public.discord_auto_cursors.last_message_id::numeric,excluded.last_message_id::numeric)::text,
        last_polled_at = excluded.last_polled_at, lease_fence = excluded.lease_fence, updated_at = excluded.updated_at;
    return jsonb_build_object('advanced',true);
  elsif p_action = 'list_pending' then
    return coalesce((select jsonb_agg(to_jsonb(q)) from
      (select * from public.discord_auto_jobs where status in ('generated','sending','uncertain')
        -- Unknown generations need no delivery reconciliation.
        and (status = 'generated' or send_started_at >= v_now - interval '1 day')
        -- Stale ambiguous deliveries cannot starve freshly generated answers.
        order by (status = 'generated') desc,updated_at,message_id limit 100) q),'[]'::jsonb);
  end if;

  v_message := p_input->>'messageId';
  if v_message is null or v_message !~ '^[0-9]{1,20}$' then raise exception 'invalid_message_id' using errcode = '22023'; end if;
  select * into j from public.discord_auto_jobs where message_id = v_message;

  if p_action = 'claim_job' then
    if j.message_id is not null then return jsonb_build_object('outcome','duplicate','job',to_jsonb(j)); end if;
    v_channel := p_input->>'channelId'; v_user := p_input->>'userId';
    v_source_hash := p_input->>'sourceHash';
    if v_channel is null or v_user is null or v_channel !~ '^[0-9]{1,20}$' or v_user !~ '^[0-9]{1,20}$' then
      raise exception 'invalid_identity' using errcode = '22023';
    end if;
    if v_source_hash is null or v_source_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_source_hash' using errcode = '22023'; end if;
    v_source_at := to_timestamp((floor(v_message::numeric / 4194304) + 1420070400000) / 1000);
    if not c.enabled or not v_master then v_reason := 'disabled';
    elsif v_channel = any(c.excluded_channel_ids) then v_reason := 'excluded';
    elsif c.activation_at is null or v_source_at < c.activation_at then v_reason := 'before_activation';
    elsif v_source_at > v_now + interval '60 seconds' then v_reason := 'future_message';
    else
      select coalesce(sum(coalesce(actual_microusd,reservation_microusd)),0),
        count(*) filter(where reservation_microusd > 0) into v_daily,v_calls
        from public.discord_auto_jobs where budget_day = v_day;
      select coalesce(sum(coalesce(actual_microusd,reservation_microusd)),0) into v_total from public.discord_auto_jobs;
      if v_daily + 16000 > c.daily_budget_microusd or v_total + 16000 > c.lifetime_budget_microusd then v_reason := 'budget';
      elsif v_calls >= c.max_replies_per_day then v_reason := 'daily_limit';
      elsif exists(select 1 from public.discord_auto_jobs where reservation_microusd > 0 and
        ((user_id = v_user and created_at > v_now - make_interval(secs => c.user_cooldown_seconds)) or
         (channel_id = v_channel and created_at > v_now - make_interval(secs => c.channel_cooldown_seconds)))) then v_reason := 'cooldown';
      end if;
    end if;
    insert into public.discord_auto_jobs(message_id,channel_id,user_id,source_hash,source_created_at,budget_day,status,reason,
      generation_fence,reservation_microusd,created_at,updated_at)
      values(v_message,v_channel,v_user,v_source_hash,v_source_at,v_day,case when v_reason is null then 'generating' else 'skipped' end,
        v_reason,v_fence,case when v_reason is null then 16000 else 0 end,v_now,v_now) returning * into j;
    return jsonb_build_object('outcome',coalesce(v_reason,'claimed'),'job',to_jsonb(j));
  end if;
  if j.message_id is null then raise exception 'job_not_found' using errcode = 'P0002'; end if;

  if p_action = 'complete_generation' then
    v_input := (p_input->>'inputTokens')::integer;
    v_output := (p_input->>'outputTokens')::integer;
    v_answer := p_input->>'answer';
    if v_input is null or v_output is null or v_input < 0 or v_input > 12000 or v_output < 0 or v_output > 700
      or not (p_input ? 'answer') or jsonb_typeof(p_input->'answer') not in ('string','null')
      or (v_answer is not null and (char_length(btrim(v_answer)) = 0 or char_length(v_answer) > 1900)) then
      raise exception 'invalid_generation' using errcode = '22023';
    end if;
    v_actual := v_input + 5::bigint * v_output;
    if j.actual_microusd is not null then
      if j.input_tokens <> v_input or j.output_tokens <> v_output then raise exception 'settlement_conflict' using errcode = '55000'; end if;
      return to_jsonb(j);
    end if;
    if j.status <> 'generating' or j.generation_fence <> v_fence or j.reservation_microusd <> 16000 then
      raise exception 'invalid_generation_state' using errcode = '55000';
    end if;
    update public.discord_auto_jobs set input_tokens = v_input, output_tokens = v_output, actual_microusd = v_actual,
      settled_at = v_now, answer = v_answer, answer_expires_at = case when v_answer is not null then v_now + interval '1 day' else null end,
      status = case when v_answer is null then 'skipped' else 'generated' end,
      reason = case when v_answer is null then 'no_answer' else null end,
      updated_at = v_now where message_id = v_message returning * into j;
    return to_jsonb(j);
  elsif p_action = 'begin_send' then
    if j.status <> 'generated' then return jsonb_build_object('outcome','not_generated'); end if;
    if not c.enabled or not v_master then return jsonb_build_object('outcome','disabled'); end if;
    if j.channel_id = any(c.excluded_channel_ids) or c.activation_at is null or j.source_created_at < c.activation_at then
      update public.discord_auto_jobs set status = 'skipped', reason = 'delivery_ineligible', answer = null,
        answer_expires_at = null, updated_at = v_now where message_id = v_message;
      return jsonb_build_object('outcome','ineligible');
    end if;
    if j.answer_expires_at is null or j.answer_expires_at <= v_now then
      update public.discord_auto_jobs set status = 'uncertain', reason = 'answer_expired', answer = null,
        answer_expires_at = null, updated_at = v_now where message_id = v_message;
      return jsonb_build_object('outcome','expired');
    end if;
    update public.discord_auto_jobs set status = 'sending', send_started_at = v_now, send_fence = v_fence,
      updated_at = v_now where message_id = v_message returning * into j;
    return jsonb_build_object('outcome','sending','job',to_jsonb(j));
  elsif p_action = 'send_rejected' then
    -- A local request budget check or explicit Discord rate-limit rejection
    -- proves no message was accepted. Restore only this worker's send attempt;
    -- do not refund generation, extend answer lifetime, or revive uncertainty.
    v_reason := p_input->>'reason';
    if v_reason is null or v_reason not in ('rate_limit','request_budget') then
      raise exception 'invalid_send_rejection' using errcode = '22023';
    end if;
    if j.status <> 'sending' or j.send_started_at is null or j.send_fence is distinct from v_fence
      or j.answer is null or j.reply_message_id is not null then
      raise exception 'invalid_delivery_state' using errcode = '55000';
    end if;
    update public.discord_auto_jobs set status = 'generated', reason = v_reason,
      send_started_at = null, send_fence = null, updated_at = v_now
      where message_id = v_message returning * into j;
    return to_jsonb(j);
  elsif p_action in ('mark_sent','reconcile_sent') then
    v_reply := p_input->>'replyId';
    if v_reply is null or v_reply !~ '^[0-9]{1,20}$' then raise exception 'invalid_reply_id' using errcode = '22023'; end if;
    if j.status = 'sent' then
      if j.reply_message_id <> v_reply then raise exception 'reply_conflict' using errcode = '55000'; end if;
      return to_jsonb(j);
    end if;
    if j.send_started_at is null or j.status not in ('sending','uncertain')
      or (p_action = 'mark_sent' and j.send_fence <> v_fence) then
      raise exception 'invalid_delivery_state' using errcode = '55000';
    end if;
    -- Caller must verify a Discord-authored reply referencing this source message.
    -- Reconciliation records an existing reply; it NEVER authorizes another POST.
    update public.discord_auto_jobs set status = 'sent', reply_message_id = v_reply,
      answer = null, answer_expires_at = null, reason = null, updated_at = v_now
      where message_id = v_message returning * into j;
    return to_jsonb(j);
  elsif p_action in ('mark_uncertain','skip_job') then
    v_reason := p_input->>'reason';
    if v_reason is null or v_reason !~ '^[a-z0-9_]{1,64}$' then raise exception 'invalid_reason' using errcode = '22023'; end if;
    if j.status in ('sent','skipped') then return to_jsonb(j); end if;
    if p_action = 'skip_job' and j.status <> 'generated' then raise exception 'invalid_skip_state' using errcode = '55000'; end if;
    update public.discord_auto_jobs set status = case when p_action = 'skip_job' then 'skipped' else 'uncertain' end, reason = v_reason,
      answer = null, answer_expires_at = null, updated_at = v_now where message_id = v_message returning * into j;
    return to_jsonb(j);
  end if;
  raise exception 'unknown_action' using errcode = '22023';
end $$;

revoke all on function public.discord_auto_state() from public, anon, authenticated;
revoke all on function public.discord_auto_transition(text,jsonb) from public, anon, authenticated;
grant execute on function public.discord_auto_state() to service_role;
grant execute on function public.discord_auto_transition(text,jsonb) to service_role;

comment on table public.discord_auto_jobs is 'Permanent Discord deduplication/cost ledger; temporary answer only; never contains student source text or bills students.';
comment on function public.discord_auto_transition(text,jsonb) is 'Service-role-only serialized lease, reservation, settlement and delivery state machine. Do not retry ambiguous model calls or Discord sends.';
notify pgrst, 'reload schema';
commit;
