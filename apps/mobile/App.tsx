import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { API_URL } from './src/config';

const TOKEN_KEY = 'starvega.auth.token';

type Membership = {
  propertyId: string;
  propertyName: string;
  role: 'OWNER' | 'MANAGER' | 'RESIDENT';
  monthlyRentCents: number | null;
};

type Profile = {
  id: string;
  name: string;
  phone: string;
  memberships: Membership[];
};

type RentDue = {
  id: string;
  month: string;
  amountCents: number;
  paidCents: number;
  dueDate: string;
  residentName?: string;
};
type AuthMode = 'login' | 'owner' | 'invitation';
type InviteRole = 'MANAGER' | 'RESIDENT';
type CreatedInvitation = { token: string; phone: string; role: InviteRole };

async function request<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'The request could not be completed');
  }
  return payload as T;
}

function formatRupees(amountCents: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [token, setToken] = useState<string>();
  const [profile, setProfile] = useState<Profile>();
  const [dues, setDues] = useState<RentDue[]>([]);
  const [selectedMembership, setSelectedMembership] = useState<Membership>();
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [invitationToken, setInvitationToken] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [address, setAddress] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteRent, setInviteRent] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('RESIDENT');
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const loadProfile = useCallback(async (authToken: string): Promise<void> => {
    try {
      const nextProfile = await request<Profile>('/auth/me', authToken);
      setProfile(nextProfile);
      setSelectedMembership(nextProfile.memberships[0]);
    } catch (requestError) {
      setError(messageOf(requestError));
      await AsyncStorage.removeItem(TOKEN_KEY);
      setToken(undefined);
    }
  }, []);

  const loadDues = useCallback(async (authToken: string, membership: Membership): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const path = membership.role === 'RESIDENT'
        ? '/rent-dues/me'
        : `/properties/${membership.propertyId}/rent-dues?month=${currentMonth}`;
      const result = await request<{ rentDues: RentDue[] }>(path, authToken);
      setDues(result.rentDues);
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setLoading(false);
    }
  }, [currentMonth]);

  useEffect(() => {
    AsyncStorage.getItem(TOKEN_KEY).then((savedToken) => {
      if (savedToken) {
        setToken(savedToken);
        loadProfile(savedToken);
      }
    }).catch(() => setError('Could not read the saved sign-in session.'));
  }, [loadProfile]);

  useEffect(() => {
    if (profile?.memberships.length && !selectedMembership) {
      setSelectedMembership(profile.memberships[0]);
    }
  }, [profile, selectedMembership]);

  useEffect(() => {
    if (token && selectedMembership) loadDues(token, selectedMembership);
  }, [token, selectedMembership, loadDues]);

  async function submitAuth(): Promise<void> {
    setLoading(true);
    setError('');
    try {
      const result = authMode === 'owner'
        ? await request<{ token: string }>('/auth/register-owner', undefined, {
            name,
            phone,
            password,
            propertyName,
            address,
          })
        : authMode === 'invitation'
          ? await request<{ token: string }>('/auth/accept-invitation', undefined, {
              token: invitationToken,
              name,
              password,
            })
          : await request<{ token: string }>('/auth/login', undefined, { phone, password });
      await AsyncStorage.setItem(TOKEN_KEY, result.token);
      setToken(result.token);
      await loadProfile(result.token);
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function generateDues(): Promise<void> {
    if (!token || !selectedMembership || !dueDate) {
      setError('Enter the rent due date before generating monthly dues.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await request(
        `/properties/${selectedMembership.propertyId}/rent-dues/generate`,
        token,
        { month: currentMonth, dueDate },
      );
      await loadDues(token, selectedMembership);
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function createInvitation(): Promise<void> {
    if (!token || !selectedMembership) return;
    const monthlyRentCents = inviteRole === 'RESIDENT' ? rupeesToPaise(inviteRent) : undefined;
    if (inviteRole === 'RESIDENT' && monthlyRentCents === undefined) {
      setError('Enter a valid monthly rent amount in rupees.');
      return;
    }

    setLoading(true);
    setError('');
    setCreatedInvitation(undefined);
    try {
      const invitation = await request<{ token: string }>(
        `/properties/${selectedMembership.propertyId}/invitations`,
        token,
        {
          phone: invitePhone,
          role: inviteRole,
          ...(monthlyRentCents === undefined ? {} : { monthlyRentCents }),
        },
      );
      setCreatedInvitation({ ...invitation, phone: invitePhone, role: inviteRole });
      setInvitePhone('');
      setInviteRent('');
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function shareInvitation(): Promise<void> {
    if (!createdInvitation) return;
    await Share.share({
      message: `You've been invited to join ${selectedMembership?.propertyName} on Starvega as a ${createdInvitation.role.toLowerCase()}. Use this invitation token in the Starvega app: ${createdInvitation.token}`,
    });
  }

  async function signOut(): Promise<void> {
    await AsyncStorage.removeItem(TOKEN_KEY);
    setToken(undefined);
    setProfile(undefined);
    setSelectedMembership(undefined);
    setDues([]);
    setPassword('');
  }

  if (!profile || !token) {
    const isOwnerRegistration = authMode === 'owner';
    const isInvitation = authMode === 'invitation';
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <ScrollView contentContainerStyle={styles.authPage} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>STARVEGA • PG MANAGEMENT</Text>
          <Text style={styles.title}>
            {isOwnerRegistration ? 'Set up your PG' : isInvitation ? 'Join your PG' : 'Welcome back'}
          </Text>
          <Text style={styles.subtitle}>
            {isOwnerRegistration
              ? 'Create your owner account to get started.'
              : isInvitation
                ? 'Accept your invitation to join as a manager or resident.'
                : 'Sign in to view your rent dashboard.'}
          </Text>
          {isOwnerRegistration && (
            <>
              <Field label="Your name" value={name} onChangeText={setName} />
              <Field label="PG name" value={propertyName} onChangeText={setPropertyName} />
              <Field label="PG address" value={address} onChangeText={setAddress} />
            </>
          )}
          {isInvitation && (
            <>
              <Field label="Invitation token" value={invitationToken} onChangeText={setInvitationToken} />
              <Field label="Your name" value={name} onChangeText={setName} />
            </>
          )}
          {!isInvitation && (
            <Field label="Phone number (include country code)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          )}
          <Field
            label={isInvitation ? 'Password (use your current password if you already have an account)' : 'Password'}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            title={isOwnerRegistration ? 'Create owner account' : isInvitation ? 'Accept invitation' : 'Sign in'}
            onPress={submitAuth}
            disabled={loading}
          />
          {loading && <ActivityIndicator color="#177864" style={styles.spinner} />}
          {authMode !== 'login' && (
            <Pressable onPress={() => { setError(''); setAuthMode('login'); }}>
              <Text style={styles.link}>Back to sign in</Text>
            </Pressable>
          )}
          {authMode === 'login' && (
            <>
              <Pressable onPress={() => { setError(''); setAuthMode('owner'); }}>
                <Text style={styles.link}>New owner? Set up a PG</Text>
              </Pressable>
              <Pressable onPress={() => { setError(''); setAuthMode('invitation'); }}>
                <Text style={styles.link}>Have an invitation? Join a PG</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  const isResident = selectedMembership?.role === 'RESIDENT';
  const outstandingCents = dues.reduce(
    (total, due) => total + Math.max(0, due.amountCents - due.paidCents),
    0,
  );
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>STARVEGA</Text>
            <Text style={styles.title}>Hello, {profile.name}</Text>
          </View>
          <Pressable onPress={signOut}><Text style={styles.link}>Sign out</Text></Pressable>
        </View>

        {profile.memberships.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.roleList}>
            {profile.memberships.map((membership) => (
              <Pressable
                key={`${membership.propertyId}-${membership.role}`}
                style={[styles.roleChip, selectedMembership === membership && styles.roleChipSelected]}
                onPress={() => {
                  setSelectedMembership(membership);
                  setCreatedInvitation(undefined);
                }}
              >
                <Text style={[styles.roleChipText, selectedMembership === membership && styles.roleChipTextSelected]}>
                  {membership.role} · {membership.propertyName}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>{isResident ? 'YOUR RENT DUES' : `${currentMonth} RENT OVERVIEW`}</Text>
          <Text style={styles.amount}>{formatRupees(outstandingCents)}</Text>
          <Text style={styles.cardSubtext}>
            {isResident
              ? `Outstanding · ${selectedMembership?.propertyName}`
              : `${dues.length} resident dues · ${selectedMembership?.propertyName}`}
          </Text>
        </View>

        {!isResident && (
          <View style={styles.generateCard}>
            <Text style={styles.sectionTitle}>Create this month's rent dues</Text>
            <Text style={styles.muted}>Uses each resident's assigned monthly rent.</Text>
            <Field label="Due date (YYYY-MM-DD)" value={dueDate} onChangeText={setDueDate} />
            <PrimaryButton title="Generate dues" onPress={generateDues} disabled={loading} />
          </View>
        )}

        {!isResident && selectedMembership && (
          <View style={styles.generateCard}>
            <Text style={styles.sectionTitle}>Invite someone to this PG</Text>
            <View style={styles.roleOptions}>
              {(['RESIDENT', ...(selectedMembership.role === 'OWNER' ? ['MANAGER'] : [])] as InviteRole[]).map((role) => (
                <Pressable
                  key={role}
                  style={[styles.roleOption, inviteRole === role && styles.roleOptionSelected]}
                  onPress={() => { setInviteRole(role); setCreatedInvitation(undefined); }}
                >
                  <Text style={[styles.roleOptionText, inviteRole === role && styles.roleOptionTextSelected]}>{role}</Text>
                </Pressable>
              ))}
            </View>
            <Field label="Phone number (include country code)" value={invitePhone} onChangeText={setInvitePhone} keyboardType="phone-pad" />
            {inviteRole === 'RESIDENT' && (
              <Field
                label="Monthly rent (₹)"
                value={inviteRent}
                onChangeText={setInviteRent}
                keyboardType="decimal-pad"
              />
            )}
            <PrimaryButton title="Create invitation" onPress={createInvitation} disabled={loading} />
            {createdInvitation && (
              <View style={styles.invitationResult}>
                <Text style={styles.fieldLabel}>Invitation token (valid for 7 days)</Text>
                <Text selectable style={styles.invitationToken}>{createdInvitation.token}</Text>
                <PrimaryButton title="Share invitation" onPress={shareInvitation} />
              </View>
            )}
          </View>
        )}

        <Text style={styles.sectionTitle}>{isResident ? 'Rent history' : 'Resident rent status'}</Text>
        {loading && <ActivityIndicator color="#177864" style={styles.spinner} />}
        {!loading && dues.length === 0 && (
          <Text style={styles.empty}>No rent dues found for this period.</Text>
        )}
        {dues.map((due) => (
          <View key={due.id} style={styles.dueRow}>
            <View>
              <Text style={styles.dueName}>{due.residentName ?? due.month}</Text>
              <Text style={styles.muted}>{due.month} · Due {String(due.dueDate).slice(0, 10)}</Text>
            </View>
            <View>
              <Text style={styles.dueAmount}>{formatRupees(due.amountCents - due.paidCents)}</Text>
              <Text style={styles.muted}>{due.paidCents >= due.amountCents ? 'Paid' : 'Pending'}</Text>
            </View>
          </View>
        ))}
        {isResident && (
          <Text style={styles.notice}>
            Online payments and receipts will appear here after a payment gateway is selected and connected.
          </Text>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput {...inputProps} style={styles.input} autoCapitalize="none" />
    </View>
  );
}

function PrimaryButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f5f7f5' },
  page: { padding: 22, paddingBottom: 40 },
  authPage: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 },
  eyebrow: { color: '#177864', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: '#18332c', fontSize: 27, fontWeight: '800', marginTop: 8 },
  subtitle: { color: '#65736e', fontSize: 15, marginTop: 8, marginBottom: 18 },
  card: { backgroundColor: '#174d40', borderRadius: 18, padding: 22, marginBottom: 22 },
  cardLabel: { color: '#cde4dc', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  amount: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 12 },
  cardSubtext: { color: '#cde4dc', fontSize: 13, marginTop: 5 },
  muted: { color: '#74817c', fontSize: 13, marginTop: 5 },
  sectionTitle: { color: '#18332c', fontSize: 17, fontWeight: '700', marginBottom: 12 },
  generateCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 22 },
  field: { marginTop: 12, marginBottom: 8 },
  fieldLabel: { color: '#43514b', fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderColor: '#dce4df', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, color: '#18332c', backgroundColor: '#fff' },
  button: { backgroundColor: '#177864', borderRadius: 11, paddingVertical: 14, alignItems: 'center', marginTop: 14 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  link: { color: '#177864', fontWeight: '700', paddingVertical: 16 },
  error: { color: '#b32727', marginTop: 12, lineHeight: 20 },
  spinner: { marginVertical: 16 },
  empty: { color: '#74817c', paddingVertical: 20 },
  dueRow: { backgroundColor: '#fff', padding: 15, borderRadius: 13, marginBottom: 9, flexDirection: 'row', justifyContent: 'space-between' },
  dueName: { color: '#18332c', fontWeight: '700' },
  dueAmount: { color: '#18332c', fontWeight: '700', textAlign: 'right' },
  roleList: { marginBottom: 16 },
  roleChip: { borderColor: '#dce4df', borderWidth: 1, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 9, marginRight: 8, backgroundColor: '#fff' },
  roleChipSelected: { backgroundColor: '#177864', borderColor: '#177864' },
  roleChipText: { color: '#43514b', fontSize: 12, fontWeight: '600' },
  roleChipTextSelected: { color: '#fff' },
  roleOptions: { flexDirection: 'row', marginTop: 4 },
  roleOption: { borderColor: '#dce4df', borderWidth: 1, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 8, marginRight: 8 },
  roleOptionSelected: { backgroundColor: '#177864', borderColor: '#177864' },
  roleOptionText: { color: '#43514b', fontSize: 12, fontWeight: '600' },
  roleOptionTextSelected: { color: '#fff' },
  invitationResult: { borderTopColor: '#e5ece8', borderTopWidth: 1, marginTop: 16, paddingTop: 12 },
  invitationToken: { color: '#18332c', fontSize: 13, marginTop: 8 },
  notice: { color: '#65736e', backgroundColor: '#eaf2ee', borderRadius: 12, padding: 14, lineHeight: 20, marginTop: 14 },
});

function rupeesToPaise(value: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) && paise > 0 && paise <= 2_147_483_647 ? paise : undefined;
}
