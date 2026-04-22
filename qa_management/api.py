import frappe


@frappe.whitelist()
def get_employee_payload():
	from frappe.utils import nowdate

	meta = frappe.get_meta("Employee")
	payload = {"doctype": "Employee"}
	missing = []

	def get_first(doctype):
		values = frappe.get_all(doctype, pluck="name", limit=1)
		return values[0] if values else None

	def get_default_company():
		return (
			frappe.defaults.get_user_default("company")
			or frappe.db.get_single_value("Global Defaults", "default_company")
			or get_first("Company")
		)

	def resolve_link_value(doctype):
		if doctype == "Company":
			return get_default_company()
		if doctype == "Employment Type":
			return get_first("Employment Type")
		if doctype == "Department":
			return get_first("Department")
		return get_first(doctype)

	for df in meta.fields:
		if not df.reqd:
			continue
		if df.fieldtype in ("Section Break", "Column Break", "Tab Break", "HTML", "Button"):
			continue
		if df.fieldname in payload:
			continue

		if df.default:
			payload[df.fieldname] = df.default
			continue

		if df.fieldtype == "Link":
			value = resolve_link_value(df.options)
			if value:
				payload[df.fieldname] = value
			else:
				missing.append(df.fieldname)
			continue

		if df.fieldtype == "Select":
			options = [o.strip() for o in (df.options or "").split("\n") if o.strip()]
			if options:
				payload[df.fieldname] = options[0]
			else:
				missing.append(df.fieldname)
			continue

		if df.fieldtype == "Date":
			payload[df.fieldname] = nowdate()
			continue

		if df.fieldtype in ("Data", "Small Text", "Long Text", "Text"):
			if df.fieldname == "first_name":
				payload[df.fieldname] = "Load"
			elif df.fieldname == "last_name":
				payload[df.fieldname] = "Test"
			else:
				payload[df.fieldname] = "Load Test"
			continue

		if df.fieldtype in ("Int", "Float"):
			payload[df.fieldname] = 0
			continue

		if df.fieldtype == "Check":
			payload[df.fieldname] = 0
			continue

		missing.append(df.fieldname)

	return {
		"payload": payload,
		"missing": missing,
	}


def _get_k6_log_dir():
	import os

	return frappe.get_site_path("private", "files", "k6_logs")


def _get_k6_log_filename(date_str):
	return f"k6_{date_str}.log"


def _append_k6_log_entry(
	*,
	status,
	run_started_at,
	run_ended_at,
	scripts,
	methods,
	vus,
	iterations,
	mode,
	remark,
	server_info,
	prob_traffic,
	stdout,
	stderr,
):
	import os
	from frappe.utils import nowdate

	log_dir = _get_k6_log_dir()
	os.makedirs(log_dir, exist_ok=True)
	filename = _get_k6_log_filename(nowdate())
	path = os.path.join(log_dir, filename)

	entry_lines = [
		"=" * 80,
		f"Run Started At: {run_started_at}",
		f"Run Ended At: {run_ended_at}",
		f"Server Environment: {server_info}",
		f"Status: {status}",
		f"Remark: {remark}" if remark else "Remark: -",
		f"Scripts: {', '.join(scripts)}" if scripts else "Scripts: -",
		f"Methods: {', '.join(methods)}" if methods else "Methods: -",
		f"VUs: {vus}",
		f"Iterations: {iterations}",
		f"Mode: {mode}",
	]

	if prob_traffic:
		traffic_line = " | ".join(
			f"{item.get('module') or item.get('script')}:{item.get('pct')}%"
			for item in prob_traffic
		)
		entry_lines.append(f"Traffic Mix: {traffic_line}")

	entry_lines.extend(
		[
			"STDOUT:",
			stdout or "",
			"STDERR:",
			stderr or "",
			"",
		]
	)

	with open(path, "a", encoding="utf-8") as handle:
		handle.write("\n".join(entry_lines))


@frappe.whitelist()
def list_k6_logs():
	import os
	from frappe.utils import datetime as frappe_datetime

	log_dir = _get_k6_log_dir()
	if not os.path.exists(log_dir):
		return []

	items = []
	for name in os.listdir(log_dir):
		if not name.endswith(".log"):
			continue
		path = os.path.join(log_dir, name)
		if not os.path.isfile(path):
			continue
		stat = os.stat(path)
		date_label = name.replace("k6_", "").replace(".log", "")
		items.append(
			{
				"filename": name,
				"date": date_label,
				"size": stat.st_size,
				"modified": frappe_datetime.datetime.fromtimestamp(stat.st_mtime).strftime(
					"%Y-%m-%d %H:%M:%S"
				),
			}
		)

	items.sort(key=lambda row: row["date"], reverse=True)
	return items


@frappe.whitelist()
def download_k6_log(filename=None, date=None):
	import os

	if not filename and date:
		filename = _get_k6_log_filename(date)

	if not filename:
		frappe.throw("filename or date is required")

	filename = os.path.basename(filename)
	path = os.path.join(_get_k6_log_dir(), filename)

	if not os.path.exists(path):
		frappe.throw("Log file not found")

	with open(path, "rb") as handle:
		frappe.response["filename"] = filename
		frappe.response["filecontent"] = handle.read()
		frappe.response["type"] = "download"


@frappe.whitelist()
def launch_k6_test(
	scripts=None,
	methods=None,
	vus=None,
	iterations=None,
	probabilistic_traffic=None,
	remark=None,
	run_id=None,
):
	import subprocess
	import os
	import json
	import selectors
	import uuid
	import time
	from frappe.utils import now_datetime

	app_path = frappe.get_app_path("load_test_manager")
	site_config = frappe.get_site_config()


	k6_api_key = "279d60e19fd668a"
	k6_api_secret = "869bae4110c5c4f"
	k6_company = site_config.get("k6_company")
	k6_employment_type = site_config.get("k6_employment_type")
	k6_department = site_config.get("k6_department")

	if not (k6_api_key and k6_api_secret):
		return {
			"status": "error",
			"stdout": "",
			"stderr": "Missing k6_api_key or k6_api_secret in site_config.json.",
		}

	def _parse_list(value):
		if value is None:
			return []
		if isinstance(value, (list, tuple)):
			return list(value)
		if isinstance(value, str):
			try:
				parsed = frappe.parse_json(value)
			except Exception:
				parsed = None
			if isinstance(parsed, list):
				return parsed
			return [v.strip() for v in value.split(",") if v.strip()]
		return [value]

	def _coerce_int(value, default=None):
		if value is None:
			return default
		try:
			return int(value)
		except (TypeError, ValueError):
			return default

	def _parse_probabilistic_traffic(value):
		if value is None:
			return []
		parsed = value
		if isinstance(value, str):
			try:
				parsed = frappe.parse_json(value)
			except Exception:
				parsed = None
		if parsed is None:
			return []
		traffic = []
		if isinstance(parsed, dict):
			items = list(parsed.items())
		else:
			items = parsed
		for item in items:
			module = None
			pct_value = None
			if isinstance(item, dict):
				module = item.get("module") or item.get("script")
				pct_value = item.get("pct") or item.get("percent") or item.get("percentage")
			elif isinstance(item, (list, tuple)) and len(item) >= 2:
				module = item[0]
				pct_value = item[1]
			elif isinstance(parsed, dict):
				module, pct_value = item
			if not module:
				continue
			try:
				pct = float(pct_value)
			except (TypeError, ValueError):
				continue
			if pct <= 0:
				continue
			traffic.append({"module": module, "pct": pct})
		return traffic

	prob_traffic = _parse_probabilistic_traffic(probabilistic_traffic)
	vus = _coerce_int(vus, 10)
	iterations = _coerce_int(iterations, 50)
	if not vus or vus < 1:
		vus = 10
	if not iterations or iterations < 1:
		iterations = 50
	remark = (remark or "").strip()
	scripts = _parse_list(scripts)
	use_router = False
	router_payload = None
	if prob_traffic:
		modules = [item["module"] for item in prob_traffic]
		if len(modules) != len(set(modules)):
			return {
				"status": "error",
				"stdout": "",
				"stderr": "Each module can be selected only once in probabilistic traffic.",
			}
		total_pct = sum(item["pct"] for item in prob_traffic)
		if abs(total_pct - 100) > 0.01:
			return {
				"status": "error",
				"stdout": "",
				"stderr": "Probabilistic traffic must sum to 100%.",
			}
		scripts = [item["module"] for item in prob_traffic]
		use_router = True
		router_payload = json.dumps(prob_traffic)

	if not scripts:
		return {
			"status": "error",
			"stdout": "",
			"stderr": "No scripts selected.",
		}

	methods = [m.strip().upper() for m in _parse_list(methods)]
	if not methods:
		methods = ["POST", "GET"]

	stdout_parts = []
	stderr_parts = []
	final_status = "success"
	run_started_at = now_datetime()

	import platform
	frappe_version = frappe.__version__
	db_host = frappe.conf.db_host or "localhost"
	server_info = f"URL: {frappe.utils.get_url()} | Site: {frappe.local.site} | DB Host: {db_host} | Frappe: v{frappe_version} | OS: {platform.system()} {platform.release()}"

	scripts_to_run = scripts
	if use_router:
		scripts_to_run = ["probabilistic_router.js"]

	processes = []
	outputs = {}
	selector = selectors.DefaultSelector()
	stream_run_id = run_id or uuid.uuid4().hex
	frappe.publish_realtime(
		"k6_log_line",
		{
			"run_id": stream_run_id,
			"script": "server_environment",
			"line": f"Server Environment: {server_info}",
		},
		user=frappe.session.user,
	)
	start_all = time.monotonic()
	start_times = {}
	script_durations = {}
	script_iteration_map = {}
	if use_router:
		script_iteration_map["probabilistic_router.js"] = iterations
	else:
		script_count = len(scripts_to_run)
		base_iters = iterations // script_count if script_count else 0
		extra_iters = iterations % script_count if script_count else 0
		for idx, script_name in enumerate(scripts_to_run):
			script_iteration_map[script_name] = base_iters + (1 if idx < extra_iters else 0)

	for script in scripts_to_run:
		script_iterations = script_iteration_map.get(script, 0)
		if script_iterations <= 0:
			continue

		cmd = [
			"k6", "run",
			"--summary-trend-stats", "avg,min,med,max,p(90),p(95),p(99)",
			f"{app_path}/k6/scripts/{script}",
			"-e", f"BASE_URL={frappe.utils.get_url()}",
			"-e", f"API_KEY={k6_api_key}",
			"-e", f"API_SECRET={k6_api_secret}",
			"-e", f"COMPANY={k6_company or ''}",
			"-e", f"EMPLOYMENT_TYPE={k6_employment_type or ''}",
			"-e", f"DEPARTMENT={k6_department or ''}",
			"-e", f"METHODS={','.join(methods)}",
			"-e", f"VUS={vus}",
			"-e", f"ITERS={script_iterations}"
		]

		if use_router and router_payload:
			cmd.extend(["-e", f"PROB_TRAFFIC={router_payload}"])

		proc = subprocess.Popen(
			cmd,
			stdout=subprocess.PIPE,
			stderr=subprocess.STDOUT,
			text=True,
			bufsize=1,
		)
		processes.append((script, proc))
		start_times[script] = time.monotonic()
		outputs[script] = []
		if proc.stdout:
			selector.register(proc.stdout, selectors.EVENT_READ, data=script)
			line = f"=== {script} ==="
			outputs[script].append(line)
			frappe.publish_realtime(
				"k6_log_line",
				{"run_id": stream_run_id, "script": script, "line": line},
				user=frappe.session.user,
			)

	while selector.get_map():
		for key, _ in selector.select(timeout=0.25):
			fileobj = key.fileobj
			script = key.data
			line = fileobj.readline()
			if line:
				clean = line.rstrip("\n")
				outputs[script].append(clean)
				frappe.publish_realtime(
					"k6_log_line",
					{"run_id": stream_run_id, "script": script, "line": clean},
					user=frappe.session.user,
				)
			else:
				selector.unregister(fileobj)
				fileobj.close()

	for script, proc in processes:
		proc.wait()
		end_time = time.monotonic()
		started_at = start_times.get(script, start_all)
		script_durations[script] = round(end_time - started_at, 3)
		stdout_parts.append("\n" + "\n".join(outputs.get(script, [])))
		if proc.returncode != 0:
			final_status = "error"

	total_duration = round(time.monotonic() - start_all, 3)
	run_ended_at = now_datetime()

	stdout_value = "".join(stdout_parts).strip()
	stderr_value = "".join(stderr_parts).strip()
	mode = "Probabilistic" if prob_traffic else "Deterministic"

	_append_k6_log_entry(
		status=final_status,
		run_started_at=run_started_at,
		run_ended_at=run_ended_at,
		scripts=scripts,
		methods=methods,
		vus=vus,
		iterations=iterations,
		mode=mode,
		remark=remark,
		server_info=server_info,
		prob_traffic=prob_traffic,
		stdout=stdout_value,
		stderr=stderr_value,
	)

	return {
		"status": final_status,
		"stdout": stdout_value,
		"stderr": stderr_value,
		"run_id": stream_run_id,
		"durations": script_durations,
		"total_duration": total_duration,
	}