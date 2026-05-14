// Copyright (c) 2026, MMCY and contributors
// For license information, please see license.txt

frappe.ui.form.on("QA Checklist", {
	checklist_template: function (frm) {
		if (frm.doc.checklist_template) {
			frappe.call({
				method: "frappe.client.get",
				args: {
					doctype: "QA Checklist Template",
					name: frm.doc.checklist_template,
				},
				callback: function (r) {
					if (r.message) {
						frm.clear_table("checklist_items");

						r.message.template_items.forEach((item) => {
							let row = frm.add_child("checklist_items");
							// use frappe.model.set_value so the model/UI is updated correctly
							frappe.model.set_value(
								row.doctype,
								row.name,
								"test_case_id",
								item.test_case_id,
							);
							frappe.model.set_value(
								row.doctype,
								row.name,
								"test_description",
								item.test_description,
							);
							frappe.model.set_value(
								row.doctype,
								row.name,
								"expected_result",
								item.expected_result,
							);
							frappe.model.set_value(row.doctype, row.name, "status", "Pending");
							frappe.model.set_value(
								row.doctype,
								row.name,
								"tested_by",
								frappe.session.user,
							);
						});

						frm.refresh_field("checklist_items");
						compute_overall_status(frm);
					}
				},
			});
		}
	},
});

// When a new row is added to the checklist_items table, give it a default test_case_id
frappe.ui.form.on("QA Checklist", "checklist_items_add", function (frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	// If no test_case_id provided, generate a prefixed consecutive id when possible
	if (!row.test_case_id) {
		const items = (frm.doc.checklist_items || []).filter((r) => r && r.test_case_id);

		let idToSet = null;

		if (items.length) {
			// try infer prefix from the first existing item's id like PREFIX-###
			const first = items[0].test_case_id.toString();
			const m = first.match(/^(.*?)-(\d+)$/);
			if (m) {
				const prefix = m[1];
				// collect numeric parts for same prefix
				// FIX: corrected regex escape — was /[-\\/\\^…]/ which double-escaped the backslash
				// and caused existing IDs to never match, resetting the counter to 001 every time
				const existingNums = items
					.map((r) => {
						const mm = r.test_case_id
							.toString()
							.match(
								new RegExp(
									"^" +
										prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") +
										"-(\\d+)$",
								),
							);
						return mm ? parseInt(mm[1], 10) : null;
					})
					.filter((n) => Number.isFinite(n));

				const maxExisting = existingNums.length ? Math.max(...existingNums) : 0;
				const next = maxExisting + 1;
				const seq = String(next).padStart(3, "0");
				idToSet = `${prefix}-${seq}`;
			}
		}

		if (!idToSet) {
			// fallback: derive prefix from checklist template name (uppercase dashes)
			let tpl = (frm.doc.checklist_template || "TEMPLATE").toString().trim();
			tpl = tpl.replace(/\s+/g, "-").toUpperCase();
			const existing = (frm.doc.checklist_items || [])
				.map((r) => {
					if (!r || !r.test_case_id) return null;
					const mm = r.test_case_id.toString().match(/(\d+)$/);
					return mm ? parseInt(mm[1], 10) : null;
				})
				.filter((n) => Number.isFinite(n));
			const maxExisting = existing.length ? Math.max(...existing) : 0;
			const next = maxExisting + 1;
			const seq = String(next).padStart(3, "0");
			idToSet = `${tpl}-${seq}`;
		}

		frappe.model.set_value(cdt, cdn, "test_case_id", idToSet);
	}
	// default status and tested_by
	if (!row.status) {
		frappe.model.set_value(cdt, cdn, "status", "Pending");
	}
	if (!row.tested_by) {
		frappe.model.set_value(cdt, cdn, "tested_by", frappe.session.user);
	}
	// ensure field values are visible/refresh grid
	frm.refresh_field("checklist_items");
	compute_overall_status(frm);
});

// update overall status when a child item's status changes
frappe.ui.form.on("QA Checklist Item", {
	status: function (frm, cdt, cdn) {
		compute_overall_status(frm);
	},
});

frappe.ui.form.on("QA Checklist", {
	onload: function (frm) {
		if (!frm.doc.tested_by) {
			frm.set_value("tested_by", frappe.session.user);
		}
		compute_overall_status(frm);
	},
	refresh: function (frm) {
		// ensure tested_by is set for new forms
		if (!frm.doc.tested_by) {
			frm.set_value("tested_by", frappe.session.user);
		}
		compute_overall_status(frm);
	},
	validate: function (frm) {
		// Enforce that visible (rendered) checklist items — except the one currently being edited —
		// have required fields filled. If any are missing, block save and show an error.
		const required_fields = ["test_case_id", "test_description", "expected_result"];
		const missing = [];
		const gridField = frm.get_field("checklist_items");

		(frm.doc.checklist_items || []).forEach(function (r) {
			try {
				let row_el = null;
				if (gridField) {
					// try a couple of selectors to find the rendered row element
					row_el =
						gridField.grid && gridField.grid.wrapper
							? gridField.grid.wrapper.find('[data-name="' + r.name + '"]')
							: null;
					if (!row_el || !row_el.length) {
						row_el =
							gridField.wrapper &&
							gridField.wrapper.find('[data-name="' + r.name + '"]');
					}
				}

				const visible = row_el && row_el.length ? row_el.is(":visible") : false;
				// heuristics to detect an actively editing row
				const isEditing =
					row_el && row_el.length
						? row_el.hasClass("grid-row-open") ||
							row_el.find(".grid-row-open").length ||
							row_el.find(".editable-row").length
						: false;

				if (visible && !isEditing) {
					const emptyFields = required_fields.filter(
						(fn) => !r[fn] || (r[fn].toString && !r[fn].toString().trim()),
					);
					if (emptyFields.length) {
						missing.push({ row: r, fields: emptyFields });
					}
				}
			} catch (e) {
				// fail-safe: ignore DOM issues
			}
		});

		if (missing.length) {
			let msg = __("Please fill required fields for visible checklist items:") + "\n\n";
			missing.forEach((m) => {
				const id = m.row.test_case_id || m.row.name || __("(unnamed)");
				msg += `- ${id}: ${m.fields.join(", ")}\n`;
			});
			frappe.msgprint(msg);
			frappe.validated = false;
		}
	},
});

function compute_overall_status(frm) {
	const rows = frm.doc.checklist_items || [];
	if (!rows.length) {
		// no items yet
		frm.set_value("status", "Pending");
		frm.refresh_field("status");
		return;
	}

	let anyFail = false;
	let allPass = true;

	rows.forEach((r) => {
		if (!r || !r.status) {
			allPass = false;
			return;
		}
		if (r.status === "Fail") {
			anyFail = true;
			allPass = false;
		} else if (r.status !== "Pass") {
			allPass = false;
		}
	});

	let overall = "Pending";
	if (anyFail) overall = "Failed";
	else if (allPass) overall = "Passed";

	if (frm.doc.status !== overall) {
		frm.set_value("status", overall);
		frm.refresh_field("status");
	}
}