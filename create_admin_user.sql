
-- Create or Update user: adminrina / calisittieasia@gmail.com
DO $$
DECLARE
  v_user_id uuid;
  v_email text := 'calisittieasia@gmail.com';
  v_username text := 'adminrina';
  v_password text := 'calicali000';
  v_role public.profile_role := 'admin';
BEGIN
  -- Check if user exists by email or previous adminrina id
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(v_email);

  IF v_user_id IS NULL THEN
    SELECT id INTO v_user_id FROM auth.users WHERE id = '9197bcae-623b-4779-b334-77f8fc5a714e';
  END IF;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
      v_user_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('full_name', v_username),
      now(),
      now()
    );
  ELSE
    UPDATE auth.users
    SET email = v_email,
        encrypted_password = crypt(v_password, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
    WHERE id = v_user_id;
  END IF;

  -- Ensure identity exists
  DELETE FROM auth.identities WHERE user_id = v_user_id;
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_user_id::text,
    v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', v_email),
    'email',
    v_user_id::text,
    now(),
    now(),
    now()
  );

  -- Ensure profile exists with username and role
  INSERT INTO public.profiles (id, full_name, username, role, is_active)
  VALUES (v_user_id, v_username, v_username, v_role, true)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      full_name = EXCLUDED.full_name,
      role = EXCLUDED.role,
      is_active = true;

  RAISE NOTICE 'Admin user % (username: %) configured successfully!', v_email, v_username;
END $$;
