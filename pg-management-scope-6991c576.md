# PG Management App: Product Scope

Source: Jatin's voice notes, Thu 26 Nov 2026 (updated after the 3:30 PM voice note). No code is started.

Labels used below:
- **[Your requirement]** you said it in the voice note
- **[Agreed]** you confirmed it in chat after the voice note
- **[Suggestion]** my idea, not accepted yet
- **[Open]** needs your decision

## 1. Idea

An app for Bengaluru PGs with three levels of access: owner, manager and resident. Each role sees only what belongs to them. Rent, complaints, announcements and expenses live in one place.

**[Your requirement]** Three separate applications: one for owners, one for managers, one for residents.
**[Open]** Three real apps, or one app with three role views? I have not changed your choice. See Open decisions.

## 2. Who sees what

### Owner [Your requirement]
- Sees only the details of their own PG(s)
- PG location, total rooms, how many are filled, how many are empty, number of residents
- Monthly due for the PG
- Maintenance work done, with bills and receipts
- Full revenue and expense view, including who added each expense (manager)
- Grocery and other spend, item by item
- Every complaint reaches the owner

### Manager [Your requirement]
- Manages one PG or more than one. You said typically 2 to 3 PGs; a hard limit is not confirmed
- Sees only the PGs assigned to them
- Number of residents, occupancy
- Who has how much rent pending
- Complaints, concerns and problems, personal or from outside
- Marks complaints solved
- Posts announcements (food updates, power cut, low water)
- Adds expenses with receipt or details so the owner can check them
- Sees expenses for the PGs they manage

### Resident [Your requirement]
- Sees only their own dashboard
- Own due amount
- Pays rent from the app through a payment gateway
- Gets notifications, for example when rent is due or something is updated
- Payment history and all receipts
- Raises complaints
- Likes other residents' complaints
- Sees the manager's contact number with a WhatsApp icon to chat directly
- Cannot see expenses or revenue

### Access table

| Data | Owner | Manager | Resident |
|---|---|---|---|
| Which PGs | Own PG(s) | Assigned PGs (typically 2-3, limit open) | Own PG |
| Rooms and occupancy | Yes | Yes | No |
| Rent due and paid | PG total | Per resident | Own only, pays in app |
| Complaints | All | All, marks solved | Raise, like, see common ones |
| Private complaints | Yes | Yes (assigned) | Only own |
| Announcements | Read | Post | Read |
| Expenses and revenue | Full | Add and see expenses of own PG(s) | No |
| Manager contact | n/a | Shown | Shown with WhatsApp button |

## 3. Flows

### Rent [Your requirement]
1. System creates a monthly due for each resident.
2. Resident gets a notification when rent is due or something is updated **[Your requirement, confirmed 3:30 PM]**.
3. Resident sees the due on the dashboard and pays in the app through a payment gateway **[Your requirement, confirmed 3:30 PM]**.
4. Receipt is saved. Resident sees full history.
5. Manager sees who is pending. Owner sees PG total due.

### Complaint [Your requirement, with agreed changes]
1. Resident raises a complaint and picks its visibility: common issue or personal/sensitive. The safety flag is set when raising it (who can set it is not decided).
2. **Common (public) issue [Agreed]:** goes to owner, manager and all residents of that PG. Residents can like it. More likes push priority up so the manager sees which problems affect most people.
3. **Private or personal [Agreed, reaffirmed 3:30 PM]:** goes only to the manager and owner (and the resident who raised it sees their own). It is not shown to any other resident. No likes.
4. **Safety issue [Agreed]:** safety is an urgency flag, separate from visibility. A safety complaint can be common or private. Its priority does not depend on likes and it is urgent from the start.
5. Manager marks it solved. Owner can see the status.
6. If it is not really solved, the same complaint is raised again [Your requirement]. How exactly is open (see decisions).

### Announcement [Your requirement]
Manager posts a food update, power cut or water shortage. Residents of that PG read it in the app.

### Expense [Your requirement]
1. Manager adds a maintenance or grocery expense with item details and receipt.
2. Owner sees it with revenue, receipt and who added it. The responsible manager sees it for their PG.
3. Residents never see expenses.

### Manager change [Your requirement]
Managers change over time and residents do not know who the manager is. The manager's number and WhatsApp icon are always shown in the resident app.

## 4. Suggestions (not accepted yet)

1. **Manager contact follows the assignment.** When the owner changes the manager, the number and WhatsApp button update by themselves.
2. **Reopen leaves a trail.** Every solved and reopened step is saved with time and person, so a complaint cannot be quietly closed.
3. **One backend, role-based screens.** Whether it ships as three apps or one, all roles use the same backend and data.

## 5. Proposed first version

Enough to run one PG end to end.

- Login with role: owner, manager, resident
- Set up a PG: rooms, beds, residents, assigned manager
- Owner dashboard: occupancy, monthly due, revenue, expenses
- Monthly rent due, in-app rent payment through a payment gateway, receipt **[Your requirement]**
- Notifications to the resident for rent due dates and updates **[Your requirement]**
- Complaints: common (public) and private visibility, safety urgency flag, likes, solved, reopen
- Manager number with WhatsApp button
- Announcements by manager
- Expenses with receipt upload, visible to owner and responsible manager, hidden from residents

### Later (my suggestion, not decided)
These are not in v1 unless you say so.
- Late fees, deposits, move-out
- Reports and export
- Owner approval for large expenses

## 6. Suggested data (if built on MERN)

- PG: name, address, rooms
- Room and Bed: PG, capacity, occupant
- User: name, phone, role
- Membership: user, PG, role (this is what limits a manager to their PGs)
- RentDue: resident, month, amount, status
- Payment (via gateway) and Receipt
- Notification: user, type (rent due, update), text, read status
- Complaint: PG, raised by, visibility (common or private), is_safety flag (urgency, independent of visibility), likes, status, history
- Announcement: PG, text, posted by
- Expense: PG, amount, category, items, receipt, added by

## 7. Open decisions

1. **Three apps or one?** You said three separate applications. Three real apps, or one app with three role views?
2. **Gateway and notifications details.** Which payment gateway, and which UPI/card options? Do notifications show only inside the app, or also as phone push or WhatsApp messages?
3. **Reopen a complaint.** Only the person who raised it, any resident, or must the resident confirm before it counts as solved?
4. **Complaint names.** Do other residents see who raised a common complaint?
5. **Manager limit.** You said typically 2 to 3 PGs. Should the app enforce a limit, or is that just a typical case?
6. **Accounts.** Owner adds managers and manager adds residents, or residents sign up and get approved?
7. **Rent rules.** Per bed or per room? Due date, late fee, deposit, food included or not?
8. **First user.** One real PG as a pilot, or a product for many Bengaluru PG owners from day one?
