// Copyright (c) 2026, MMCY and contributors
// For license information, please see license.txt

frappe.ui.form.on('QA Checklist', {
    checklist_template: function(frm) {
        if (frm.doc.checklist_template) {
            frappe.call({
                method: "frappe.client.get",
                args: {
                    doctype: "QA Checklist Template",
                    name: frm.doc.checklist_template
                },
                callback: function(r) {
                    if (r.message) {
                        frm.clear_table("checklist_items");

                        r.message.template_items.forEach(item => {
                            let row = frm.add_child("checklist_items");
                            row.test_case_id = item.test_case_id;
                            row.test_description = item.test_description;
                            row.expected_result = item.expected_result;
                            row.status = 'In Progress';
                            row.tested_by = frappe.session.user;
                        });

                        frm.refresh_field("checklist_items");
                        compute_overall_status(frm);
                    }
                }
            });
        }
    }
});

// When a new row is added to the checklist_items table, give it a default test_case_id
frappe.ui.form.on('QA Checklist', 'checklist_items_add', function(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    // If no test_case_id provided, set a simple incremental id (matches row number)
    if (!row.test_case_id) {
        row.test_case_id = String(frm.doc.checklist_items.length);
    }
    // default status and tested_by
    if (!row.status) {
        row.status = 'In Progress';
    }
    if (!row.tested_by) {
        row.tested_by = frappe.session.user;
    }
    // ensure field values are visible/refresh grid
    frm.refresh_field('checklist_items');
    compute_overall_status(frm);
});

// update overall status when a child item's status changes
frappe.ui.form.on('QA Checklist Item', {
    status: function(frm, cdt, cdn) {
        compute_overall_status(frm);
    }
});

frappe.ui.form.on('QA Checklist', {
    onload: function(frm) {
        if (!frm.doc.tested_by) {
            frm.set_value('tested_by', frappe.session.user);
        }
        compute_overall_status(frm);
    },
    refresh: function(frm) {
        // ensure tested_by is set for new forms
        if (!frm.doc.tested_by) {
            frm.set_value('tested_by', frappe.session.user);
        }
        compute_overall_status(frm);
    }
});

function compute_overall_status(frm) {
    const rows = frm.doc.checklist_items || [];
    if (!rows.length) {
        // no items yet
        frm.set_value('status', 'In Progress');
        frm.refresh_field('status');
        return;
    }

    let anyFail = false;
    let allPass = true;

    rows.forEach(r => {
        if (!r || !r.status) {
            allPass = false;
            return;
        }
        if (r.status === 'Fail') {
            anyFail = true;
            allPass = false;
        } else if (r.status !== 'Pass') {
            allPass = false;
        }
    });

    let overall = 'In Progress';
    if (anyFail) overall = 'Failed';
    else if (allPass) overall = 'Passed';

    if (frm.doc.status !== overall) {
        frm.set_value('status', overall);
        frm.refresh_field('status');
    }
}
